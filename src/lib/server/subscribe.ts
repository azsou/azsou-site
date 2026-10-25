/**
 * /api/subscribe 的处理逻辑（T7.8 邮件订阅，双重确认；与 Astro 解耦，便于单元测试与 E2E 复用）：
 *   1. 同源检查 + 输入校验（src/lib/subscribe-form.ts，与数据库 0016 同一套规则）
 *   2. 发信服务没配置 → 503（不写数据库、不发信）；Turnstile / 票据密钥没配置（部署环境）→ 503
 *   3. 服务端校验 Turnstile → 签发 HMAC 票据（与留言板同一套，kind = 'subscribe'）
 *   4. 生成确认令牌（32 字节随机）与退订令牌（HMAC(密钥, 'unsubscribe|' + 邮箱)），只把 sha256 交给数据库
 *   5. subscribe_request() 返回 send = true 时发确认信（含确认与退订链接）；已订阅 / 10 分钟内发过的不再发
 *   6. 对访客的回答永远是「请查收确认邮件」，不透露这个邮箱是否已订阅
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  checkSubscribe,
  confirmPath,
  subscribePayload,
  unsubscribePath,
  type SubLang,
} from '../subscribe-form';
import { verifyTurnstile } from './turnstile';
import { resolveSecret } from './guarded-auth';
import { clientHash, makeCommunityTicket, resolveTicketSecret, type SubmitEnv } from './community-submit';
import { mailerFromEnv, type Mail, type MailEnv, type Mailer } from './mailer';

export interface SubscribeDeps {
  fetch?: typeof fetch;
  verifyFetch?: typeof fetch;
  /** 测试注入（CI 用内存发信器，永远不真的发信）；不传 = 按环境变量选择 */
  mailer?: Mailer | null;
  now?: () => number;
  defaults: { url: string; key: string };
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const unsubscribeToken = (secret: string, email: string) =>
  createHmac('sha256', secret).update(`unsubscribe|${email}`).digest('hex');

const MSG = {
  zh: {
    ok: '请查收确认邮件：点击邮件里的链接后订阅才会生效。没收到的话看看垃圾邮件箱。',
    notConfigured: '邮件订阅暂未开放，可以先用 RSS 订阅。',
    captcha: '请先完成人机验证',
    captchaFailed: '人机验证没有通过，请重试',
    rate: '提交太频繁，请稍后再试。',
    ticket: '提交凭证无效，请刷新页面后重试',
    upstream: '数据服务暂时不可用，请稍后再试。',
    send: '确认邮件发送失败，请过 10 分钟再试。',
    bad: '请求格式不正确',
    origin: '来源不正确',
    method: '只支持 POST',
  },
  en: {
    ok: 'Check your inbox: the subscription starts only after you click the link in the confirmation email. Look in spam if it does not arrive.',
    notConfigured: 'Email updates are not available yet — you can follow the RSS feed instead.',
    captcha: 'Please complete the verification first',
    captchaFailed: 'Verification failed, please try again',
    rate: 'Too many requests, please try again later.',
    ticket: 'Invalid request token, please reload the page and try again',
    upstream: 'The service is temporarily unavailable, please try again later.',
    send: 'The confirmation email could not be sent. Please try again in 10 minutes.',
    bad: 'Invalid request',
    origin: 'Invalid origin',
    method: 'POST only',
  },
} as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export function confirmationMail(o: {
  origin: string;
  email: string;
  lang: SubLang;
  confirm: string;
  unsub: string;
}): Mail {
  const confirmUrl = `${o.origin}${confirmPath(o.lang)}#token=${o.confirm}`;
  const unsubUrl = `${o.origin}${unsubscribePath(o.lang)}#token=${o.unsub}`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const t =
    o.lang === 'en'
      ? {
          subject: 'Confirm your AZ Studio subscription',
          hi: 'Someone (hopefully you) asked to receive AZ Studio updates at this address.',
          cta: 'Confirm subscription',
          expires:
            'The link is valid for 48 hours. If you did not ask for this, just ignore this email — nothing will be sent.',
          unsub: 'Unsubscribe at any time',
        }
      : {
          subject: '请确认订阅 AZ Studio 更新',
          hi: '有人（希望是你）用这个邮箱订阅了 AZ Studio 的更新。',
          cta: '确认订阅',
          expires: '链接 48 小时内有效。如果不是你本人操作，忽略这封邮件即可，之后不会再收到任何邮件。',
          unsub: '随时退订',
        };
  return {
    to: o.email,
    subject: t.subject,
    text: `${t.hi}\n\n${t.cta}: ${confirmUrl}\n\n${t.expires}\n\n${t.unsub}: ${unsubUrl}\n`,
    html: `<p>${esc(t.hi)}</p><p><a href="${esc(confirmUrl)}">${esc(t.cta)}</a></p><p>${esc(t.expires)}</p><p style="color:#6e6e73;font-size:13px"><a href="${esc(unsubUrl)}">${esc(t.unsub)}</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
  };
}

export async function handleSubscribe(
  request: Request,
  env: SubmitEnv & MailEnv,
  deps: SubscribeDeps,
  clientIp?: string,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error_code: 'method_not_allowed', msg: MSG.zh.method });
  const origin = new URL(request.url).origin;
  const reqOrigin = request.headers.get('origin');
  if (reqOrigin && reqOrigin !== origin) return json(403, { error_code: 'bad_origin', msg: MSG.zh.origin });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error_code: 'validation_failed', msg: MSG.zh.bad });
  }
  if (typeof body !== 'object' || body === null)
    return json(400, { error_code: 'validation_failed', msg: MSG.zh.bad });
  const checked = checkSubscribe(body);
  const lang: SubLang = body.lang === 'en' ? 'en' : 'zh';
  const m = MSG[lang];
  if (!checked.ok)
    return json(400, { error_code: 'validation_failed', field: checked.field, msg: checked.msg });

  // 发信服务没配置：直接 503，什么都不存、什么都不发
  const mailer = deps.mailer === undefined ? mailerFromEnv(env, deps.fetch) : deps.mailer;
  const turnstileSecret = resolveSecret(env);
  const ticketSecret = resolveTicketSecret(env);
  if (!mailer || !turnstileSecret || !ticketSecret)
    return json(503, { error_code: 'not_configured', msg: m.notConfigured });

  const token = typeof body.captchaToken === 'string' ? body.captchaToken : '';
  if (!token) return json(400, { error_code: 'captcha_failed', field: 'turnstile', msg: m.captcha });
  const v = await verifyTurnstile(token, turnstileSecret, {
    ip: clientIp,
    fetch: deps.verifyFetch ?? deps.fetch,
  });
  if (!v.success)
    return json(400, { error_code: 'turnstile_failed', field: 'turnstile', msg: m.captchaFailed });

  const { email } = checked.value;
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const client = clientHash(ticketSecret, clientIp ?? '');
  const ticket = makeCommunityTicket(
    ticketSecret,
    'subscribe',
    subscribePayload(checked.value),
    client,
    nowSec,
  );
  const confirm = randomBytes(32).toString('hex');
  const unsub = unsubscribeToken(ticketSecret, email);
  const url = env.PUBLIC_SUPABASE_URL || deps.defaults.url;
  const key = env.PUBLIC_SUPABASE_KEY || deps.defaults.key;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${url}/rest/v1/rpc/subscribe_request`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        p_email: email,
        p_lang: lang,
        p_confirm_hash: sha256(confirm),
        p_unsubscribe_hash: sha256(unsub),
        p_ticket: ticket,
      }),
    });
  } catch {
    return json(502, { error_code: 'upstream_unavailable', msg: m.upstream });
  }
  const text = await res.text();
  let parsed: Record<string, unknown> | null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const code = String(parsed?.code ?? '');
    if (code === 'PT429' || res.status === 429) return json(429, { error_code: 'rate_limited', msg: m.rate });
    if (code === 'PT503') return json(503, { error_code: 'not_configured', msg: m.notConfigured });
    if (code === '42501') return json(403, { error_code: 'ticket_rejected', msg: m.ticket });
    if (code === '22023')
      return json(400, {
        error_code: 'validation_failed',
        field: 'email',
        msg: lang === 'en' ? 'Please enter a valid email address' : '邮箱地址格式不正确',
      });
    if (code === 'PGRST202' || code === '42883')
      return json(503, { error_code: 'not_migrated', msg: m.notConfigured });
    return json(502, { error_code: 'upstream_error', msg: m.upstream });
  }
  if (parsed?.send === true) {
    try {
      await mailer.send(confirmationMail({ origin, email, lang, confirm, unsub }));
    } catch {
      return json(502, { error_code: 'send_failed', msg: m.send });
    }
  }
  return json(200, { ok: true, status: 'check_inbox', msg: m.ok });
}
