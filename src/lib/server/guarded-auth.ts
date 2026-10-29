/**
 * /api/auth/[action] 的处理逻辑（与 Astro 解耦，便于单元测试）：
 *   1. 校验 Turnstile token（服务端，带用户 IP）
 *   2. 通过后由服务端把请求转发给 Supabase Auth（GoTrue）
 *      signup → /auth/v1/signup（附 signup_ticket）   recover → /auth/v1/recover   resend → /auth/v1/resend
 * 密钥：TURNSTILE_SECRET_KEY（Vercel 环境变量）。部署环境（VERCEL_ENV=production/preview）缺少密钥时拒绝服务，
 * 本地开发 / 测试自动使用 Cloudflare 的「总是通过」测试密钥。
 */
import { makeSignupTicket, TURNSTILE_TEST, verifyTurnstile } from './turnstile';

export type GuardedAction = 'signup' | 'recover' | 'resend';
export const ACTIONS: GuardedAction[] = ['signup', 'recover', 'resend'];

export interface GuardedEnv {
  TURNSTILE_SECRET_KEY?: string;
  /** 设为 1 时部署环境也允许测试密钥（例如没有真实密钥的预览站） */
  TURNSTILE_ALLOW_TEST_KEYS?: string;
  SIGNUP_TICKET_SECRET?: string;
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_KEY?: string;
  VERCEL_ENV?: string;
}

export interface GuardedDeps {
  fetch?: typeof fetch;
  now?: () => number;
  defaults: { url: string; key: string };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;

export function resolveSecret(env: GuardedEnv): string | null {
  if (env.TURNSTILE_SECRET_KEY) return env.TURNSTILE_SECRET_KEY;
  const deployed = env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
  if (deployed && env.TURNSTILE_ALLOW_TEST_KEYS !== '1') return null;
  return TURNSTILE_TEST.secretPass;
}

/** 只允许跳回本站的 /auth/callback/（防止借本站发带外链的邮件） */
export function safeRedirect(requested: unknown, origin: string): string {
  const fallback = `${origin}/auth/callback/`;
  if (typeof requested !== 'string') return fallback;
  try {
    const u = new URL(requested, origin);
    if (u.origin !== origin || !u.pathname.startsWith('/auth/callback/')) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

/**
 * 站点设置「注册已关闭」（site_content kind=setting slug=registration {"open":false}）。
 * 读不到（网络 / 旧库）时视为开放：注册钩子（0009）在数据库侧还有一道拦截。
 */
export async function registrationClosed(
  url: string,
  key: string,
  f: typeof fetch = fetch,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await f(
      `${url}/rest/v1/site_content?kind=eq.setting&slug=eq.registration&published=eq.true&select=data`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: ctrl.signal },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as { data?: { open?: unknown } }[];
    return Array.isArray(rows) && rows[0]?.data?.open === false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleGuardedAuth(
  action: string | undefined,
  request: Request,
  env: GuardedEnv,
  deps: GuardedDeps,
  clientIp?: string,
): Promise<Response> {
  if (!action || !ACTIONS.includes(action as GuardedAction))
    return json(404, { error_code: 'not_found', msg: '未知操作' });
  if (request.method !== 'POST') return json(405, { error_code: 'method_not_allowed', msg: '只支持 POST' });
  const origin = new URL(request.url).origin;
  // 同源检查：浏览器跨站提交会带别的 Origin
  const reqOrigin = request.headers.get('origin');
  if (reqOrigin && reqOrigin !== origin) return json(403, { error_code: 'bad_origin', msg: '来源不正确' });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error_code: 'validation_failed', msg: '请求格式不正确' });
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL_RE.test(email)) return json(400, { error_code: 'email_address_invalid', msg: '邮箱地址不正确' });

  const secret = resolveSecret(env);
  if (!secret) return json(503, { error_code: 'turnstile_not_configured', msg: 'Turnstile 未配置' });
  const token = typeof body.captchaToken === 'string' ? body.captchaToken : '';
  if (!token) return json(400, { error_code: 'captcha_failed', msg: '缺少人机验证' });
  const v = await verifyTurnstile(token, secret, { ip: clientIp, fetch: deps.fetch });
  if (!v.success)
    return json(400, { error_code: 'turnstile_failed', msg: '人机验证没有通过', codes: v.codes });

  // deps.defaults 是调用方按 scripts/supabase-env.mjs 判定好的配置（env 优先、Vercel 非生产缺配置即报错），
  // 这里不再自行把 env 与默认值混用（fail-closed，2026-10-28）
  const { url, key } = deps.defaults;
  const redirectTo = safeRedirect(body.redirectTo, origin);
  let path: string;
  let payload: Record<string, unknown>;
  if (action === 'signup') {
    if (await registrationClosed(url, key, deps.fetch))
      return json(403, { error_code: 'registration_closed', msg: '本站暂时关闭了新用户注册' });
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 72)
      return json(400, { error_code: 'weak_password', msg: '密码长度 8–72 位' });
    const data = (body.data ?? {}) as Record<string, unknown>;
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 40) : '';
    const meta: Record<string, string> = { name };
    if (env.SIGNUP_TICKET_SECRET) {
      meta.signup_ticket = makeSignupTicket(env.SIGNUP_TICKET_SECRET, email, deps.now?.());
    }
    path = 'signup';
    payload = { email, password, data: meta };
  } else if (action === 'recover') {
    path = 'recover';
    payload = { email };
  } else {
    path = 'resend';
    payload = { type: 'signup', email };
  }
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(
      `${url}/auth/v1/${path}?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method: 'POST',
        headers: {
          apikey: key,
          'content-type': 'application/json',
          ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return json(502, { error_code: 'upstream_unavailable', msg: '认证服务暂时不可达' });
  }
  const text = await res.text();
  return new Response(text || '{}', {
    status: res.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
