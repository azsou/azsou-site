/**
 * 发信抽象（T7.8）：Resend（HTTP API）或 SMTP（nodemailer），由环境变量选择。
 *   EMAIL_PROVIDER = resend | smtp（不写时：有 RESEND_API_KEY 用 Resend，有 SMTP_HOST 用 SMTP）
 *   EMAIL_FROM     = 发件人，如「AZ Studio <hello@azsou.com>」（必填）
 *   Resend：RESEND_API_KEY
 *   SMTP  ：SMTP_HOST、SMTP_PORT（默认 465）、SMTP_USER、SMTP_PASS、SMTP_SECURE（默认 port = 465 时为 true）
 * 什么都没配置 → mailerFromEnv() 返回 null，/api/subscribe 直接 503：不写数据库、不发任何邮件。
 * 测试与 CI 用 createMemoryMailer()（只记在内存里），永远不会真的发信。
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}
export interface Mailer {
  provider: 'resend' | 'smtp' | 'memory';
  send(m: Mail): Promise<void>;
}

export interface MailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_SECURE?: string;
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

export function createResendMailer(apiKey: string, from: string, f: typeof fetch = fetch): Mailer {
  return {
    provider: 'resend',
    async send(m) {
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [m.to],
          subject: m.subject,
          text: m.text,
          html: m.html,
          headers: m.headers,
        }),
      });
      if (!res.ok) throw new MailError(`resend ${res.status}`);
    },
  };
}

export function createSmtpMailer(env: Required<Pick<MailEnv, 'SMTP_HOST' | 'EMAIL_FROM'>> & MailEnv): Mailer {
  const port = Number(env.SMTP_PORT || 465);
  return {
    provider: 'smtp',
    async send(m) {
      const { createTransport } = await import('nodemailer');
      const t = createTransport({
        host: env.SMTP_HOST,
        port,
        secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
      });
      try {
        await t.sendMail({
          from: env.EMAIL_FROM,
          to: m.to,
          subject: m.subject,
          text: m.text,
          html: m.html,
          headers: m.headers,
        });
      } catch (e) {
        throw new MailError(`smtp ${(e as Error)?.message ?? ''}`.trim());
      }
    },
  };
}

/** 环境变量 → 发信器；没配置完整时返回 null（调用方返回 503） */
export function mailerFromEnv(env: MailEnv, f?: typeof fetch): Mailer | null {
  if (!env.EMAIL_FROM) return null;
  const provider = env.EMAIL_PROVIDER || (env.RESEND_API_KEY ? 'resend' : env.SMTP_HOST ? 'smtp' : '');
  if (provider === 'resend' && env.RESEND_API_KEY)
    return createResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM, f);
  if (provider === 'smtp' && env.SMTP_HOST)
    return createSmtpMailer({ ...env, SMTP_HOST: env.SMTP_HOST, EMAIL_FROM: env.EMAIL_FROM });
  return null;
}

/** 测试用：只记录，不发信 */
export function createMemoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    provider: 'memory',
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}
