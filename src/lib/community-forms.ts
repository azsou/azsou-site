/**
 * 留言板（T7.3）与友链申请（T7.4）的输入规则：浏览器、Vercel Function、单元测试共用，
 * 与 db/migrations/0015_guestbook.sql 的约束 / RPC 校验一致（数据库是最终裁判）。
 * 票据摘要用的 payload 也在这里定义，Function 与数据库按同一字符串计算 HMAC。
 */
export const GUESTBOOK_LIMITS = { nickname: 24, body: 500, links: 2 } as const;
export const LINK_LIMITS = { name: 40, url: 200, description: 120, contact: 120 } as const;

export interface GuestbookInput {
  nickname: string;
  body: string;
}
export interface LinkInput {
  name: string;
  url: string;
  description: string;
  contact: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; field: string; msg: string };

const len = (s: string) => [...s].length;
// 与数据库一致：昵称 / 名称等单行字段不允许任何控制字符；留言正文允许换行与制表符
// eslint-disable-next-line no-control-regex -- 就是要匹配控制字符
const CTRL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- 同上（允许 \t \n）
const CTRL_BODY = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function checkGuestbook(
  input: Partial<Record<keyof GuestbookInput, unknown>>,
): Checked<GuestbookInput> {
  const nickname = str(input.nickname).trim();
  const body = str(input.body).replace(/\r\n/g, '\n').trim();
  if (!nickname || len(nickname) > GUESTBOOK_LIMITS.nickname || CTRL.test(nickname))
    return { ok: false, field: 'nickname', msg: `昵称需要 1–${GUESTBOOK_LIMITS.nickname} 个字` };
  if (!body || len(body) > GUESTBOOK_LIMITS.body || CTRL_BODY.test(body))
    return { ok: false, field: 'body', msg: `留言需要 1–${GUESTBOOK_LIMITS.body} 个字` };
  if ((body.match(/https?:\/\//gi) ?? []).length > GUESTBOOK_LIMITS.links)
    return { ok: false, field: 'body', msg: `留言里的链接太多（最多 ${GUESTBOOK_LIMITS.links} 个）` };
  return { ok: true, value: { nickname, body } };
}

/** 只接受 https，主机名小写（new URL 会规范化）、不带账号密码与片段 */
export function normalizeSiteUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(u.hostname)) return null;
  u.hash = '';
  const s = u.toString();
  return s.length <= LINK_LIMITS.url && !/\s/.test(s) ? s : null;
}

export function checkLink(input: Partial<Record<keyof LinkInput, unknown>>): Checked<LinkInput> {
  const name = str(input.name).trim();
  const description = str(input.description).trim();
  const contact = str(input.contact).trim();
  if (!name || len(name) > LINK_LIMITS.name || CTRL.test(name))
    return { ok: false, field: 'name', msg: `站点名称需要 1–${LINK_LIMITS.name} 个字` };
  const url = normalizeSiteUrl(str(input.url));
  if (!url) return { ok: false, field: 'url', msg: '网址需要以 https:// 开头' };
  if (len(description) > LINK_LIMITS.description || CTRL.test(description))
    return { ok: false, field: 'description', msg: `简介最多 ${LINK_LIMITS.description} 个字` };
  if (len(contact) > LINK_LIMITS.contact || CTRL.test(contact))
    return { ok: false, field: 'contact', msg: `联系方式最多 ${LINK_LIMITS.contact} 个字` };
  return { ok: true, value: { name, url, description, contact } };
}

export type SubmitKind = 'guestbook' | 'link';
export const SUBMIT_KINDS: SubmitKind[] = ['guestbook', 'link'];

/** 票据摘要的原文（与 0015 的 guestbook_submit / friend_link_submit 拼法一致） */
export const ticketPayload = (kind: SubmitKind, v: GuestbookInput | LinkInput): string =>
  kind === 'guestbook'
    ? `${(v as GuestbookInput).nickname}\n${(v as GuestbookInput).body}`
    : [
        (v as LinkInput).name,
        (v as LinkInput).url,
        (v as LinkInput).description,
        (v as LinkInput).contact,
      ].join('\n');
