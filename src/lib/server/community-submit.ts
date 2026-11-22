/**
 * /api/submit/[kind] 的处理逻辑（T7.3 留言 / T7.4 友链申请；与 Astro 解耦，便于单元测试与 E2E 复用）：
 *   1. 同源检查 + 输入校验（src/lib/community-forms.ts，与数据库规则一致）
 *   2. 服务端校验 Turnstile（带用户 IP）
 *   3. 签发 HMAC 票据（内容摘要 + 时间 + 带密钥的 IP 摘要），调用数据库 RPC（anon key）；
 *      数据库用同一个密钥核对票据、一次性、限流，然后写入 pending（db/migrations/0015_guestbook.sql）。
 * 密钥：TURNSTILE_SECRET_KEY（注册页已在用）、COMMUNITY_TICKET_SECRET（新增，同时写进 private.app_settings）。
 * 部署环境（VERCEL_ENV=production/preview）缺少任一密钥时返回 503；本地 / 测试使用测试密钥。
 */
import { createHash, createHmac } from 'node:crypto';
import { checkGuestbook, checkLink, SUBMIT_KINDS, ticketPayload, type SubmitKind } from '../community-forms';
import { verifyTurnstile } from './turnstile';
import { resolveSecret } from './guarded-auth';

/** 本地开发 / CI 用的票据密钥（E2E 的 global-setup 把同一个值写进测试库） */
export const COMMUNITY_TEST_SECRET = 'az-local-community-ticket-secret';

export interface SubmitEnv {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ALLOW_TEST_KEYS?: string;
  COMMUNITY_TICKET_SECRET?: string;
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_KEY?: string;
  VERCEL_ENV?: string;
}

export interface SubmitDeps {
  fetch?: typeof fetch;
  /** 只用于 Turnstile siteverify（测试里单独替换） */
  verifyFetch?: typeof fetch;
  now?: () => number;
  defaults: { url: string; key: string };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function resolveTicketSecret(env: SubmitEnv): string | null {
  if (env.COMMUNITY_TICKET_SECRET) return env.COMMUNITY_TICKET_SECRET;
  const deployed = env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';
  return deployed ? null : COMMUNITY_TEST_SECRET;
}

/** 带密钥的访客摘要：数据库用它限流，但拿不到 IP 本身 */
export const clientHash = (secret: string, ip: string) =>
  createHmac('sha256', secret)
    .update(`client|${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);

export function makeCommunityTicket(
  secret: string,
  kind: SubmitKind | 'subscribe',
  payload: string,
  client: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  const sig = createHmac('sha256', secret).update(`${kind}|${nowSec}|${client}|${digest}`).digest('hex');
  return `${nowSec}.${client}.${sig}`;
}

/** PostgREST 错误 → 用户能看懂的中文（数据库的 message 已经是中文） */
function upstreamError(status: number, body: Record<string, unknown> | null) {
  const code = String(body?.code ?? '');
  const message = String(body?.message ?? '');
  if (code === 'PT429' || status === 429)
    return json(429, {
      error_code: 'rate_limited',
      msg: String(body?.hint ?? '') || '提交太频繁，请稍后再试。',
    });
  if (code === 'PT503' || status === 503)
    return json(503, { error_code: 'not_configured', msg: message || '暂未开放' });
  if (code === '23505') return json(409, { error_code: 'duplicate', msg: message || '已经申请过了' });
  if (code === '22023' || code === '23514')
    return json(400, { error_code: 'validation_failed', msg: message });
  if (code === 'PGRST202' || code === '42883')
    return json(503, { error_code: 'not_migrated', msg: '数据库还没有执行 0015 迁移' });
  if (code === '42501') return json(403, { error_code: 'ticket_rejected', msg: message || '提交凭证无效' });
  return json(502, { error_code: 'upstream_error', msg: '数据服务暂时不可用，请稍后再试。' });
}

export async function handleCommunitySubmit(
  kind: string | undefined,
  request: Request,
  env: SubmitEnv,
  deps: SubmitDeps,
  clientIp?: string,
): Promise<Response> {
  if (!kind || !SUBMIT_KINDS.includes(kind as SubmitKind))
    return json(404, { error_code: 'not_found', msg: '未知操作' });
  if (request.method !== 'POST') return json(405, { error_code: 'method_not_allowed', msg: '只支持 POST' });
  const origin = new URL(request.url).origin;
  const reqOrigin = request.headers.get('origin');
  if (reqOrigin && reqOrigin !== origin) return json(403, { error_code: 'bad_origin', msg: '来源不正确' });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error_code: 'validation_failed', msg: '请求格式不正确' });
  }
  if (typeof body !== 'object' || body === null)
    return json(400, { error_code: 'validation_failed', msg: '请求格式不正确' });
  const k = kind as SubmitKind;
  const checked = k === 'guestbook' ? checkGuestbook(body) : checkLink(body);
  if (!checked.ok)
    return json(400, { error_code: 'validation_failed', field: checked.field, msg: checked.msg });

  const turnstileSecret = resolveSecret(env);
  const ticketSecret = resolveTicketSecret(env);
  if (!turnstileSecret || !ticketSecret)
    return json(503, { error_code: 'not_configured', msg: '留言与友链申请暂未开放' });
  const token = typeof body.captchaToken === 'string' ? body.captchaToken : '';
  if (!token) return json(400, { error_code: 'captcha_failed', msg: '请先完成人机验证' });
  const v = await verifyTurnstile(token, turnstileSecret, {
    ip: clientIp,
    fetch: deps.verifyFetch ?? deps.fetch,
  });
  if (!v.success)
    return json(400, { error_code: 'turnstile_failed', msg: '人机验证没有通过，请重试', codes: v.codes });

  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const client = clientHash(ticketSecret, clientIp ?? '');
  const ticket = makeCommunityTicket(ticketSecret, k, ticketPayload(k, checked.value), client, nowSec);
  // deps.defaults 是调用方按 scripts/supabase-env.mjs 判定好的配置（env 优先、Vercel 非生产缺配置即报错），
  // 这里不再自行把 env 与默认值混用（fail-closed，2026-10-28）
  const { url, key } = deps.defaults;
  const value = checked.value as unknown as Record<string, string>;
  const [rpc, args] =
    k === 'guestbook'
      ? ['guestbook_submit', { p_nickname: value.nickname, p_body: value.body, p_ticket: ticket }]
      : [
          'friend_link_submit',
          {
            p_name: value.name,
            p_url: value.url,
            p_description: value.description,
            p_contact: value.contact,
            p_ticket: ticket,
          },
        ];
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${url}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    return json(502, { error_code: 'upstream_unavailable', msg: '数据服务暂时不可达，请稍后再试。' });
  }
  const text = await res.text();
  let parsed: Record<string, unknown> | null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) return upstreamError(res.status, parsed);
  return json(200, { ok: true, status: 'pending', id: parsed?.id ?? null });
}
