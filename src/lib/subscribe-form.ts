/**
 * 邮件订阅表单（T7.8）的校验：浏览器、Vercel Function（/api/subscribe）与数据库（0016）同一套规则。
 * 邮箱统一小写、去首尾空白；格式与 0016 的 subscribers_email_check 一致（宁严勿宽：不接受带引号 / IP 字面量的地址）。
 */
import type { Checked } from './community-forms';

export type SubLang = 'zh' | 'en';
export interface SubscribeInput {
  email: string;
  lang: SubLang;
}
export const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const EMAIL_MAX = 254;

const MSG = {
  zh: { email: '请输入有效的邮箱地址', long: `邮箱地址太长（最多 ${EMAIL_MAX} 个字符）` },
  en: {
    email: 'Please enter a valid email address',
    long: `That address is too long (max ${EMAIL_MAX} characters)`,
  },
} as const;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function checkSubscribe(
  input: Partial<Record<keyof SubscribeInput, unknown>>,
): Checked<SubscribeInput> {
  const lang: SubLang = input.lang === 'en' ? 'en' : 'zh';
  const email = normalizeEmail(input.email);
  if (email.length > EMAIL_MAX) return { ok: false, field: 'email', msg: MSG[lang].long };
  if (email.length < 6 || !EMAIL_RE.test(email)) return { ok: false, field: 'email', msg: MSG[lang].email };
  return { ok: true, value: { email, lang } };
}

/** 票据绑定的内容（与 0016 subscribe_request 里 e || '\n' || l 一致） */
export const subscribePayload = (v: SubscribeInput) => `${v.email}\n${v.lang}`;

/** 确认 / 退订页面的地址（令牌放在 # 片段里：不进服务器日志，也不会随 Referer 发出） */
export const confirmPath = (lang: SubLang) =>
  lang === 'en' ? '/en/subscribe/confirm/' : '/subscribe/confirm/';
export const unsubscribePath = (lang: SubLang) =>
  lang === 'en' ? '/en/subscribe/unsubscribe/' : '/subscribe/unsubscribe/';
export const TOKEN_RE = /^[0-9a-f]{64}$/;

/** 从 location.hash / search 里取令牌（#token=… 或 ?token=…） */
export function tokenFrom(hash: string, search = ''): string | null {
  for (const s of [hash.replace(/^#/, ''), search.replace(/^\?/, '')]) {
    const t = new URLSearchParams(s).get('token');
    if (t && TOKEN_RE.test(t)) return t;
  }
  return null;
}
