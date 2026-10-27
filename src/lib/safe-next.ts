/**
 * 登录 / 回调后的跳转目标（?next=）只允许本站路径（I01 / T074：错误 redirect 必须被拒，不跳任意外域）。
 *
 * 以前只看前缀（以 / 开头、不以 // 或 /\ 开头）。但浏览器解析 URL 时会先删掉制表符和换行（WHATWG URL 标准），
 * 「/<TAB>/evil.example」在 location.replace() 里就变成协议相对地址「//evil.example」——登录后跳到外域。
 * 现在：任何控制字符 / 空白 / 反斜杠直接拒绝，再用 URL 解析确认仍是同源，并且只返回 路径 + 查询 + 锚点。
 */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex -- 就是要拦控制字符（浏览器会静默删除 \t \n \r，其余也不该出现在站内路径里）
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return fallback;
  let u: URL;
  try {
    u = new URL(raw, 'https://site.invalid');
  } catch {
    return fallback;
  }
  if (u.origin !== 'https://site.invalid') return fallback;
  if (/^\/(login|register|auth)\//.test(u.pathname)) return fallback;
  return u.pathname + u.search + u.hash;
}
