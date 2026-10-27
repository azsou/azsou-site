/**
 * 账户页面（/login/ /register/ /reset-password/ /settings/ /auth/callback/）的交互。
 * 只在这些页面加载；所有请求经仓储接口（src/lib/data），权限由数据库与 Supabase Auth 决定。
 */
import { AuthError, checkLength, getRepository, LIMITS, type OAuthProvider, type Profile } from '@/lib/data';
import { navigateSameOrigin, safeNext } from '@/lib/safe-next';
import { PROFILE_KEY } from './user-menu';

const repo = getRepository();
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);

// ------------------------------------------------------------------ 通用 ----

// 登录后的跳转目标只允许本站路径：safeNext（src/lib/safe-next.ts，I01 / T074）；真正导航时再经 navigateSameOrigin 校验同源
const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const callbackUrl = (n?: string) =>
  `${location.origin}/auth/callback/${n && n !== '/' ? `?next=${encodeURIComponent(n)}` : ''}`;

function rememberProfile(p: Profile | null) {
  try {
    if (p)
      localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify({ id: p.id, displayName: p.displayName, role: p.role }),
      );
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* 隐私模式 */
  }
  dispatchEvent(new CustomEvent('az:auth'));
}

function status(form: HTMLElement, msg: string, kind: 'error' | 'ok' = 'error') {
  const el = $('[data-form-status]', form);
  if (!el) return;
  el.classList.toggle('notice--error', kind === 'error');
  el.classList.toggle('notice--ok', kind === 'ok');
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
}

function fieldError(form: HTMLFormElement, name: string, msg: string | null) {
  const input = form.elements.namedItem(name) as HTMLInputElement | null;
  const out = $(`[data-error-for="${name}"]`, form);
  if (out) {
    out.textContent = msg ?? '';
    if (input && !out.id) out.id = `${input.id || name}-error`;
  }
  if (input) {
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      if (out) input.setAttribute('aria-describedby', out.id);
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
  }
  return !msg;
}

function busy(form: HTMLFormElement, on: boolean) {
  const b = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!b) return;
  b.disabled = on;
  b.setAttribute('aria-busy', String(on));
}

const val = (form: HTMLFormElement, name: string) =>
  ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim();
const raw = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function emailError(v: string) {
  if (!v) return '请填写邮箱';
  return EMAIL_RE.test(v) ? null : '邮箱地址不正确';
}
export function passwordError(v: string) {
  if (v.length < LIMITS.password[0]) return `密码至少 ${LIMITS.password[0]} 位`;
  if (v.length > LIMITS.password[1]) return `密码最多 ${LIMITS.password[1]} 位`;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return '密码需要同时包含字母和数字';
  return null;
}

function errorText(e: unknown) {
  if (e instanceof AuthError) return e.message;
  if (e && typeof e === 'object' && 'name' in e && (e as Error).name === 'DataUnavailableError')
    return '网络或服务暂时不可用，请稍后再试。';
  return (e as Error)?.message || '出错了，请稍后再试。';
}

function onSubmit(name: string, fn: (form: HTMLFormElement) => Promise<void>) {
  document.querySelectorAll<HTMLFormElement>(`[data-auth-form="${name}"]`).forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      status(form, '');
      form.setAttribute('aria-busy', 'true');
      busy(form, true);
      try {
        await fn(form);
      } catch (err) {
        status(form, errorText(err));
      } finally {
        form.removeAttribute('aria-busy');
        busy(form, false);
      }
    });
  });
}

// ------------------------------------------------------------- Turnstile ----

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
let turnstileLoading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  turnstileLoading ??= new Promise((resolve, reject) => {
    window.azTurnstileReady = () => resolve(window.turnstile!);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=azTurnstileReady';
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error('turnstile'));
    document.head.append(s);
  });
  return turnstileLoading;
}

/** 每个表单里的 Turnstile 小组件；token() 取当前 token，reset() 提交后重置（token 一次性） */
function turnstileFor(form: HTMLFormElement) {
  const el = $('[data-turnstile]', form);
  let token = '';
  let id: string | undefined;
  let api: TurnstileApi | undefined;
  const hint = $('[data-turnstile-hint]', form);
  if (el) {
    loadTurnstile()
      .then((t) => {
        api = t;
        id = t.render(el, {
          sitekey: el.dataset.sitekey,
          action: el.dataset.action,
          theme: 'auto',
          language: 'zh-cn',
          callback: (t2: string) => {
            token = t2;
            fieldError(form, 'turnstile', null);
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
  }
  return {
    token: () => token,
    reset() {
      token = '';
      if (api) api.reset(id);
    },
  };
}

// ----------------------------------------------------------------- OAuth ----

document.querySelectorAll<HTMLButtonElement>('[data-oauth]').forEach((b) => {
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const url = await repo.auth.oauthUrl(b.dataset.oauth as OAuthProvider, callbackUrl(next));
      location.assign(url);
    } catch (e) {
      b.disabled = false;
      const form = b.closest('.auth-card')?.querySelector<HTMLFormElement>('form');
      if (form) status(form, errorText(e));
    }
  });
});

// ----------------------------------------------------------------- 登录 ----

async function afterSignIn(target = next) {
  const p = await repo.profiles.me().catch(() => null);
  rememberProfile(p);
  // 最终导航前再做一次同源校验（第二道防线，I01 / T074 第 3 轮）
  navigateSameOrigin(target, 'assign');
}

{
  const s = repo.auth.getSession();
  const already = $('[data-already]');
  if (s && already) {
    already.hidden = false;
    $('[data-already-name]', already)!.textContent = s.user.metaName || s.user.email || '';
  }
}

onSubmit('login', async (form) => {
  const email = val(form, 'email');
  const password = raw(form, 'password');
  const okEmail = fieldError(form, 'email', emailError(email));
  const okPw = fieldError(form, 'password', password ? null : '请填写密码');
  if (!okEmail || !okPw) return;
  try {
    await repo.auth.signIn(email, password);
  } catch (e) {
    if (e instanceof AuthError && e.code === 'email_not_confirmed') {
      const r = $('[data-resend]', form);
      if (r) {
        r.hidden = false;
        $<HTMLAnchorElement>('[data-resend-link]', r)!.href =
          `/register/?mode=resend&email=${encodeURIComponent(email)}`;
      }
    }
    throw e;
  }
  status(form, '登录成功，正在跳转…', 'ok');
  await afterSignIn();
});

// ----------------------------------------------------------------- 注册 ----

{
  const regPanel = $('[data-register-panel]');
  const resendPanel = $('[data-resend-panel]');
  if (regPanel && resendPanel && params.get('mode') === 'resend') {
    regPanel.hidden = true;
    resendPanel.hidden = false;
    const email = params.get('email');
    if (email) (resendPanel.querySelector('input[name="email"]') as HTMLInputElement).value = email;
  }
}

// 站点设置：注册已关闭 → 收起注册表单与第三方注册（服务端 /api/auth/signup 与注册钩子另行拦截）
{
  const regPanel = $('[data-register-panel]');
  if (regPanel)
    void import('./site-settings').then(async ({ loadSiteSettings }) => {
      const s = await loadSiteSettings({ fresh: true });
      if (s.registration.open) return;
      const notice = $('[data-register-closed]', regPanel)!;
      if (s.registration.message)
        $('[data-register-closed-text]', notice)!.textContent = s.registration.message;
      notice.hidden = false;
      $('form[data-auth-form="register"]', regPanel)!.hidden = true;
      const alt = $('[data-register-alt]', regPanel);
      if (alt) alt.hidden = true;
    });
}

const captchas = new Map<HTMLFormElement, ReturnType<typeof turnstileFor>>();
// 只给可见的表单渲染 Turnstile（注册页同时有「注册」与「重新发送」两个表单，只显示其中一个）
document
  .querySelectorAll<HTMLFormElement>('form[data-auth-form]')
  .forEach((f) => $('[data-turnstile]', f) && !f.closest('[hidden]') && captchas.set(f, turnstileFor(f)));
function requireCaptcha(form: HTMLFormElement): string | null {
  const t = captchas.get(form)?.token() ?? '';
  if (!t) {
    status(form, '请先完成人机验证（如果没有看到验证框，请刷新页面）。');
    return null;
  }
  return t;
}

onSubmit('register', async (form) => {
  const name = val(form, 'displayName');
  const email = val(form, 'email');
  const pw = raw(form, 'password');
  const checks = [
    fieldError(form, 'displayName', checkLength(name, LIMITS.displayName, '昵称')),
    fieldError(form, 'email', emailError(email)),
    fieldError(form, 'password', passwordError(pw)),
    fieldError(form, 'password2', raw(form, 'password2') === pw ? null : '两次输入的密码不一致'),
    fieldError(
      form,
      'agree',
      (form.elements.namedItem('agree') as HTMLInputElement).checked ? null : '请先同意使用条款与隐私说明',
    ),
  ];
  if (checks.includes(false)) return;
  const captchaToken = requireCaptcha(form);
  if (!captchaToken) return;
  try {
    const r = await repo.auth.signUp({
      email,
      password: pw,
      displayName: name,
      captchaToken,
      redirectTo: callbackUrl('/settings/?welcome=1'),
    });
    if (r.session) {
      await afterSignIn('/settings/?welcome=1');
      return;
    }
    const done = $('[data-register-done]');
    $('[data-register-panel]')!.hidden = true;
    if (done) {
      done.hidden = false;
      $('[data-done-email]', done)!.textContent = email;
      $<HTMLAnchorElement>('[data-done-resend]', done)!.href =
        `/register/?mode=resend&email=${encodeURIComponent(email)}`;
      done.querySelector<HTMLElement>('h2')?.setAttribute('tabindex', '-1');
      done.querySelector<HTMLElement>('h2')?.focus();
    }
  } finally {
    captchas.get(form)?.reset();
  }
});

onSubmit('resend', async (form) => {
  const email = val(form, 'email');
  if (!fieldError(form, 'email', emailError(email))) return;
  const captchaToken = requireCaptcha(form);
  if (!captchaToken) return;
  try {
    await repo.auth.resendConfirmation(email, {
      captchaToken,
      redirectTo: callbackUrl('/settings/?welcome=1'),
    });
    status(form, '如果这个邮箱已注册且尚未验证，确认邮件已重新发送，请查收。', 'ok');
  } finally {
    captchas.get(form)?.reset();
  }
});

// ------------------------------------------------------------- 找回密码 ----

{
  const req = $('[data-reset-request]');
  const upd = $('[data-reset-update]');
  if (req && upd && params.get('mode') === 'update') {
    req.hidden = true;
    const s = repo.auth.getSession();
    if (s) {
      upd.hidden = false;
      $('[data-reset-title]')!.textContent = '设置新密码';
      $('[data-reset-email]', upd)!.textContent = s.user.email ?? '';
    } else {
      $('[data-reset-expired]')!.hidden = false;
    }
  }
}

onSubmit('reset-request', async (form) => {
  const email = val(form, 'email');
  if (!fieldError(form, 'email', emailError(email))) return;
  const captchaToken = requireCaptcha(form);
  if (!captchaToken) return;
  try {
    await repo.auth.requestPasswordReset(email, { captchaToken, redirectTo: callbackUrl() });
    status(form, '如果这个邮箱已注册，重置链接已经发出。请查收邮件（也看看垃圾邮件文件夹）。', 'ok');
  } finally {
    captchas.get(form)?.reset();
  }
});

async function updatePassword(form: HTMLFormElement) {
  const pw = raw(form, 'password');
  const ok =
    fieldError(form, 'password', passwordError(pw)) &&
    fieldError(form, 'password2', raw(form, 'password2') === pw ? null : '两次输入的密码不一致');
  if (!ok) return false;
  await repo.auth.updatePassword(pw);
  return true;
}

onSubmit('reset-update', async (form) => {
  if (!(await updatePassword(form))) return;
  status(form, '密码已更新，正在前往账户设置…', 'ok');
  setTimeout(() => location.assign('/settings/'), 800);
});

// ----------------------------------------------------------------- 设置 ----

const PROVIDERS: Record<string, string> = { email: '邮箱密码', github: 'GitHub', google: 'Google' };
const ROLES: Record<string, string> = { user: '用户', moderator: '版主', admin: '管理员' };

async function loadSettings() {
  const signedIn = $('[data-settings-signed-in]');
  const signedOut = $('[data-settings-signed-out]');
  if (!signedIn || !signedOut) return;
  const s = repo.auth.getSession();
  if (!s) return;
  signedOut.hidden = true;
  signedIn.hidden = false;
  if (params.get('welcome')) $('[data-welcome]')!.hidden = false;
  $('[data-acc-email]')!.textContent = s.user.email ?? '（未提供）';
  $('[data-acc-provider]')!.textContent = PROVIDERS[s.user.provider] ?? s.user.provider;
  const pwCard = $('[data-password-card]');
  if (pwCard) {
    pwCard.hidden = s.user.provider !== 'email';
    const u = $<HTMLInputElement>('[data-username]', pwCard);
    if (u) u.value = s.user.email ?? '';
  }
  const nameInput = $<HTMLInputElement>('#set-name');
  try {
    const p = await repo.profiles.me();
    if (!p) return;
    rememberProfile(p);
    if (nameInput) nameInput.value = p.displayName;
    $('[data-acc-role]')!.textContent = p.banned
      ? `${ROLES[p.role] ?? p.role}（已限制发言）`
      : (ROLES[p.role] ?? p.role);
    $('[data-acc-created]')!.textContent = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'long',
      timeZone: 'Asia/Shanghai',
    }).format(new Date(p.createdAt));
  } catch (e) {
    const form = $<HTMLFormElement>('[data-auth-form="settings-name"]');
    if (form) status(form, `读取资料失败：${errorText(e)}`);
  }
}
void loadSettings();

onSubmit('settings-name', async (form) => {
  const name = val(form, 'displayName');
  if (!fieldError(form, 'displayName', checkLength(name, LIMITS.displayName, '昵称'))) return;
  const p = await repo.profiles.updateDisplayName(name);
  rememberProfile(p);
  status(form, '昵称已保存。', 'ok');
});

onSubmit('settings-password', async (form) => {
  if (!(await updatePassword(form))) return;
  form.reset();
  status(form, '密码已更新。', 'ok');
});

$('[data-signout-btn]')?.addEventListener('click', async () => {
  await repo.auth.signOut();
  rememberProfile(null);
  location.assign('/');
});

// -------------------------------------------------------------- 回调页 ----

async function handleCallback() {
  const box = $('[data-callback]');
  if (!box) return;
  const r = await repo.auth.handleCallback(new URL(location.href));
  // 地址栏里的 token 立即清掉，避免留在历史记录里
  history.replaceState(null, '', location.pathname);
  if (r.error || !r.session) {
    $('[data-cb-title]', box)!.textContent = '链接无法使用';
    $('[data-cb-status]', box)!.textContent = '';
    const err = $('[data-cb-error]', box)!;
    err.hidden = false;
    err.textContent = r.error ?? '链接不完整或已失效。';
    $('[data-cb-actions]', box)!.hidden = false;
    return;
  }
  const p = await repo.profiles.me().catch(() => null);
  rememberProfile(p);
  $('[data-cb-title]', box)!.textContent = r.type === 'recovery' ? '验证成功' : '登录成功';
  $('[data-cb-status]', box)!.textContent = '正在跳转…';
  const target =
    r.type === 'recovery'
      ? '/reset-password/?mode=update'
      : r.type === 'signup'
        ? safeNext(params.get('next'), '/settings/?welcome=1')
        : next;
  navigateSameOrigin(target, 'replace');
}
void handleCallback();
