/**
 * 内容后台（T7.7，Decap CMS）的 GitHub OAuth：/api/cms/auth → GitHub 授权 → /api/cms/callback → 把令牌交给 /cms/ 窗口。
 * Decap 的 GitHub 后端在弹窗里打开 auth_endpoint，等弹窗用 postMessage 回传
 *   'authorization:github:success:{"token":"…","provider":"github"}'。
 * 环境变量（Vercel）：CMS_GITHUB_CLIENT_ID、CMS_GITHUB_CLIENT_SECRET（GitHub OAuth App，回调地址 https://azsou.com/api/cms/callback）。
 * 没配置 → 503。state 用 HttpOnly Cookie 防 CSRF；回调页的内联脚本用一次性 nonce（这条路由不走全站 CSP，见 vercel.json）。
 * 令牌只在浏览器的 Decap 里使用，本站不保存。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface CmsEnv {
  CMS_GITHUB_CLIENT_ID?: string;
  CMS_GITHUB_CLIENT_SECRET?: string;
}
export interface CmsDeps {
  fetch?: typeof fetch;
}

const STATE_COOKIE = 'az_cms_state';
const html = (status: number, body: string, nonce: string, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...extra,
    },
  });

/** 回调页：先告诉 opener「授权中」，收到 opener 回复（同源）后把结果发回去 */
export function callbackPage(
  origin: string,
  nonce: string,
  result: { token?: string; error?: string },
): string {
  const status = result.token ? 'success' : 'error';
  const payload = result.token
    ? { token: result.token, provider: 'github' }
    : { error: result.error ?? 'unknown' };
  const msg = `authorization:github:${status}:${JSON.stringify(payload)}`;
  const js = JSON.stringify(msg).replace(/</g, '\\u003c');
  const o = JSON.stringify(origin).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录内容后台</title></head><body>
<p>${status === 'success' ? '登录成功，正在返回内容后台…' : '登录失败，请关闭这个窗口后重试。'}</p>
<script nonce="${nonce}">(function(){var o=${o},m=${js};function r(e){if(e.origin!==o)return;window.removeEventListener('message',r);window.opener&&window.opener.postMessage(m,o);setTimeout(function(){window.close()},300)}window.addEventListener('message',r);window.opener&&window.opener.postMessage('authorizing:github',o)})();</script>
</body></html>`;
}

const cookieOf = (req: Request, name: string) =>
  (req.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .map((c) => c.split('='))
    .find(([k]) => k === name)?.[1] ?? '';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export async function handleCmsOAuth(
  action: string | undefined,
  request: Request,
  env: CmsEnv,
  deps: CmsDeps = {},
): Promise<Response> {
  const nonce = randomBytes(16).toString('base64');
  const u = new URL(request.url);
  const origin = u.origin;
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (action !== 'auth' && action !== 'callback') return new Response('Not Found', { status: 404 });
  if (!env.CMS_GITHUB_CLIENT_ID || !env.CMS_GITHUB_CLIENT_SECRET)
    return html(
      503,
      '<!doctype html><title>内容后台未配置</title><p>内容后台的 GitHub 登录还没有配置（CMS_GITHUB_CLIENT_ID / CMS_GITHUB_CLIENT_SECRET）。</p>',
      nonce,
    );

  if (action === 'auth') {
    const state = randomBytes(24).toString('hex');
    // 公开仓库用 public_repo 就够了；Decap 请求 repo 时照给（私有仓库需要）
    const scope = u.searchParams.get('scope') === 'public_repo' ? 'public_repo,read:user' : 'repo,read:user';
    const target = new URL('https://github.com/login/oauth/authorize');
    target.searchParams.set('client_id', env.CMS_GITHUB_CLIENT_ID);
    target.searchParams.set('redirect_uri', `${origin}/api/cms/callback`);
    target.searchParams.set('scope', scope);
    target.searchParams.set('state', state);
    return new Response(null, {
      status: 302,
      headers: {
        location: target.toString(),
        'cache-control': 'no-store',
        'set-cookie': `${STATE_COOKIE}=${state}; Path=/api/cms/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  const clear = {
    'set-cookie': `${STATE_COOKIE}=; Path=/api/cms/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  };
  const code = u.searchParams.get('code') ?? '';
  const state = u.searchParams.get('state') ?? '';
  if (!code || !same(state, cookieOf(request, STATE_COOKIE)))
    return html(400, callbackPage(origin, nonce, { error: 'state_mismatch' }), nonce, clear);
  let token: string | undefined;
  try {
    const res = await (deps.fetch ?? fetch)('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: env.CMS_GITHUB_CLIENT_ID,
        client_secret: env.CMS_GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${origin}/api/cms/callback`,
      }),
    });
    const j = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !j.access_token)
      return html(502, callbackPage(origin, nonce, { error: j.error ?? 'exchange_failed' }), nonce, clear);
    token = j.access_token;
  } catch {
    return html(502, callbackPage(origin, nonce, { error: 'github_unreachable' }), nonce, clear);
  }
  return html(200, callbackPage(origin, nonce, { token }), nonce, clear);
}
