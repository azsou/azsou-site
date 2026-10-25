/**
 * Cloudflare Turnstile 小组件（留言板 / 友链申请用；注册页沿用 auth-pages.ts 里的同一套做法）。
 * 脚本只在表单真正需要时加载（显式渲染），主题跟随站点当前明暗。
 */
import { effectiveTheme } from './theme';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    azTurnstileReady?: () => void;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    window.azTurnstileReady = () => resolve(window.turnstile!);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=azTurnstileReady';
    s.async = true;
    s.defer = true;
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.append(s);
  });
  return loading;
}

export interface Captcha {
  token(): string;
  reset(): void;
}

/** 在 form 里的 [data-turnstile] 上渲染；hint 显示加载失败原因 */
export function mountTurnstile(form: HTMLElement, onToken?: () => void): Captcha {
  const el = form.querySelector<HTMLElement>('[data-turnstile]');
  const hint = form.querySelector<HTMLElement>('[data-turnstile-hint]');
  let token = '';
  let id: string | undefined;
  let api: TurnstileApi | undefined;
  if (el)
    load()
      .then((t) => {
        api = t;
        id = t.render(el, {
          sitekey: el.dataset.sitekey,
          action: el.dataset.action,
          theme: effectiveTheme(),
          language: 'zh-cn',
          callback: (v: string) => {
            token = v;
            onToken?.();
          },
          'expired-callback': () => (token = ''),
          'error-callback': () => {
            token = '';
            if (hint) hint.textContent = '人机验证加载失败，请刷新页面重试。';
          },
        });
      })
      .catch(() => {
        if (hint) hint.textContent = '无法连接人机验证服务（challenges.cloudflare.com），请检查网络后刷新。';
      });
  return {
    token: () => token,
    reset() {
      token = '';
      api?.reset(id);
    },
  };
}
