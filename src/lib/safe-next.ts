/**
 * 登录 / 回调后的跳转目标（?next=）只允许本站路径（I01 / T074：错误 redirect 必须被拒，不跳任意外域）。
 *
 * 第 1 轮：浏览器解析 URL 时会先删掉制表符和换行（WHATWG URL 标准），「/<TAB>/evil.example」变成「//evil.example」。
 * 第 3 轮：点段规范化同样能造出协议相对地址——「/.//evil.example」「/a/..//evil.example」「/%2e//evil.example」
 * 经 URL 解析后路径是「//evil.example」，以前把它原样返回，location.assign() 就跳到外域。
 *
 * 现在的规则（全部满足才放行，否则返回 fallback）：
 * 1. 原始值以单个 / 开头；不含控制字符 / 空白 / 反斜杠。
 * 2. 反复百分号解码（最多 4 层）后的每一层都不含控制字符 / 空白 / 反斜杠，也不含编码过的 . / \（%2e %2f %5c）——
 *    站内路径从来不需要它们，留着只会让某一层（代理 / 服务器 / 浏览器）解码后变成 // 或 ..。
 * 3. 用 new URL(raw, origin) 解析：解析后同源，且规范化后的路径不以 // 或 /\ 开头。
 * 4. 返回规范化后的 路径 + 查询 + 锚点（不是原始输入），并且再解析一次确认仍同源。
 */
const ORIGIN = 'https://site.invalid';
// eslint-disable-next-line no-control-regex -- 就是要拦控制字符（浏览器会静默删除 \t \n \r，其余也不该出现在站内路径里）
const BAD_CHARS = /[\u0000-\u0020\u007f\\]/;
const ENCODED_SEP = /%(2e|2f|5c)/i;

/** 规范化后的 路径+查询+锚点 在 origin 下仍然同源、且不是协议相对地址 */
function normalizedSameOrigin(target: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(target, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const out = u.pathname + u.search + u.hash;
  if (out.startsWith('//') || out.startsWith('/\\') || !out.startsWith('/')) return null;
  // 再解析一次：返回值交给浏览器时必须仍落在本站
  try {
    if (new URL(out, origin).origin !== origin) return null;
  } catch {
    return null;
  }
  return out;
}

/** 反复解码后的每一层都不能出现危险字符或编码分隔符 */
function layersClean(raw: string): boolean {
  let cur = raw.split(/[?#]/, 1)[0];
  for (let i = 0; i < 4; i++) {
    if (BAD_CHARS.test(cur) || ENCODED_SEP.test(cur)) return false;
    let dec: string;
    try {
      dec = decodeURIComponent(cur);
    } catch {
      return false;
    }
    if (dec === cur) return !BAD_CHARS.test(dec);
    cur = dec;
  }
  return false; // 4 层还没解完：不是正常路径
}

export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (BAD_CHARS.test(raw) || !layersClean(raw)) return fallback;
  const out = normalizedSameOrigin(raw, ORIGIN);
  if (!out) return fallback;
  if (/^\/(login|register|auth)\//.test(out)) return fallback;
  return out;
}

/**
 * 最终导航前的同源校验（第二道防线）：所有登录 / 回调后的 location.assign / replace 都先过这里。
 * 即使上游（safeNext 或以后新增的分支）给了坏值，导航时也换成 fallback，不离开本站。
 */
export function sameOriginTarget(target: string, origin: string, fallback = '/'): string {
  if (typeof target !== 'string' || BAD_CHARS.test(target)) return fallback;
  return normalizedSameOrigin(target, origin) ?? fallback;
}

/** 浏览器里按 sameOriginTarget 校验后再导航 */
export function navigateSameOrigin(target: string, mode: 'assign' | 'replace' = 'assign', fallback = '/') {
  const safe = sameOriginTarget(target, location.origin, fallback);
  if (mode === 'replace') location.replace(safe);
  else location.assign(safe);
}
