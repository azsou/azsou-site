/**
 * Cloudflare Turnstile 服务端校验 + 注册票据（仅服务端使用，勿在浏览器里引用）。
 * 文档：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cloudflare 官方测试密钥（任何域名可用）：https://developers.cloudflare.com/turnstile/troubleshooting/testing/ */
export const TURNSTILE_TEST = {
  /** 总是通过（可见挑战） */
  siteKeyPass: '1x00000000000000000000AA',
  /** 总是失败 */
  siteKeyFail: '2x00000000000000000000AB',
  secretPass: '1x0000000000000000000000000000000AA',
  secretFail: '2x0000000000000000000000000000000AA',
  /** 测试 site key 在浏览器里产出的假 token */
  dummyToken: 'XXXX.DUMMY.TOKEN.XXXX',
} as const;

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  codes: string[];
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(
  token: string,
  secret: string,
  opts: { ip?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<TurnstileResult> {
  if (!token || token.length > 2048) return { success: false, codes: ['missing-input-response'] };
  const body = new URLSearchParams({ secret, response: token });
  if (opts.ip) body.set('remoteip', opts.ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await (opts.fetch ?? fetch)(SITEVERIFY_URL, { method: 'POST', body, signal: ctrl.signal });
    const j = (await res.json()) as { success?: boolean; 'error-codes'?: string[]; hostname?: string; action?: string };
    return { success: j.success === true, codes: j['error-codes'] ?? [], hostname: j.hostname, action: j.action };
  } catch (e) {
    return { success: false, codes: ['internal-error', (e as Error).name] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册票据：`<unix秒>.<hex(HMAC-SHA256(secret, lower(email) + "." + unix秒))>`。
 * 服务端校验 Turnstile 后签发，写进 user_metadata.signup_ticket；
 * 数据库的 before-user-created 钩子（db/migrations/0007）用同一算法核对，
 * 这样绕过本站直接调 GoTrue /signup 的机器人会被拒绝。
 */
export function makeSignupTicket(secret: string, email: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const ts = String(nowSec);
  const sig = createHmac('sha256', secret).update(`${email.trim().toLowerCase()}.${ts}`).digest('hex');
  return `${ts}.${sig}`;
}

export function checkSignupTicket(secret: string, email: string, ticket: string, nowSec = Math.floor(Date.now() / 1000), maxAgeSec = 900): boolean {
  const [ts, sig] = ticket.split('.');
  if (!/^\d{9,11}$/.test(ts ?? '') || !/^[0-9a-f]{64}$/.test(sig ?? '')) return false;
  if (Math.abs(nowSec - Number(ts)) > maxAgeSec) return false;
  const want = Buffer.from(makeSignupTicket(secret, email, Number(ts)).split('.')[1], 'hex');
  return timingSafeEqual(want, Buffer.from(sig, 'hex'));
}
