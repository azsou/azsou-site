// 固定目标绑定（r16）：两个诊断分支（/search/、/apps/）共用同一份逻辑，目标只由环境变量 DIAG_TARGET_URL 给出。
// URL 比较一律用 WHATWG URL 解析后比较「origin + 规范化 pathname」，不用 includes() / startsWith() 之类的子串判断：
//   - origin 由 URL 解析得到（协议 / 主机小写、默认端口省略）；
//   - pathname 去掉末尾所有 '/' 再比较，根路径记为 '/'（所以 /search 与 /search/ 相同，/search/x、/searchx/ 不同）；
//   - 查询串与 # 片段不参与比较（Lighthouse 的 requestedUrl / mainDocumentUrl 不会自带它们；固定目标也没有）。
// 解析失败的 URL 一律视为「不匹配」，绝不回退到别的判断方式。

/** @param {unknown} raw @returns {{ ok: true, origin: string, path: string, key: string } | { ok: false, error: string }} */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, error: 'URL 缺失或不是字符串' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'URL 无法解析' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `协议不是 http(s)：${u.protocol}` };
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return { ok: true, origin: u.origin, path, key: `${u.origin}${path}` };
}

/** 两个 URL 是否指向同一个固定目标（origin + 规范化 pathname 完全相等）。 */
export function sameTarget(a, b) {
  const x = normalizeUrl(a);
  const y = normalizeUrl(b);
  return x.ok && y.ok && x.key === y.key;
}

/** 读取并校验固定目标；不合法就抛错（调用方据此退出非 0，不猜目标）。 */
export function targetFromEnv(env = process.env) {
  const raw = env.DIAG_TARGET_URL;
  const n = normalizeUrl(raw);
  if (!n.ok) throw new Error(`DIAG_TARGET_URL 不合法（${n.error}）`);
  return { raw, ...n };
}

/**
 * LHR 与固定目标的绑定检查。requestedUrl 必须存在且匹配；最终 URL（finalDisplayedUrl、mainDocumentUrl，
 * 以及已废弃但仍会写出的 finalUrl）至少要有一个，且出现的每一个都必须匹配。任一不符 → 该样本无效（不能算作本目标的有效样本）。
 * @returns {{ ok: boolean, reasons: string[], urls: Record<string, string | null> }}
 */
export function checkLhrTarget(L, target) {
  const urls = {
    requestedUrl: L?.requestedUrl ?? null,
    finalDisplayedUrl: L?.finalDisplayedUrl ?? null,
    mainDocumentUrl: L?.mainDocumentUrl ?? null,
    finalUrl: L?.finalUrl ?? null,
  };
  const reasons = [];
  if (urls.requestedUrl === null) reasons.push('LHR 没有 requestedUrl');
  else if (!sameTarget(urls.requestedUrl, target.raw)) reasons.push(`requestedUrl 不是固定目标（${String(urls.requestedUrl).slice(0, 200)}）`);
  const finals = ['finalDisplayedUrl', 'mainDocumentUrl', 'finalUrl'].filter((k) => urls[k] !== null);
  if (finals.length === 0) reasons.push('LHR 没有 finalDisplayedUrl / mainDocumentUrl');
  for (const k of finals)
    if (!sameTarget(urls[k], target.raw)) reasons.push(`${k} 不是固定目标（${String(urls[k]).slice(0, 200)}）`);
  return { ok: reasons.length === 0, reasons, urls };
}
