/**
 * 中英双语（T7.6）：中文是默认语言，在根路径；英文在 /en/ 下。
 *  - 只有真正写了英文文案的条目才有 /en/ 页面（内容集合的 `en` 字段）；文章没有英文版，英文文章页只列标题并标注「Chinese only」。
 *  - 有对应页面时双向输出 hreflang（zh-CN / en / x-default = 中文），语言切换按钮保留路径；
 *    没有英文版的中文页面，切换按钮指向 /en/ 首页。
 */
export type Lang = 'zh' | 'en';
export const LOCALES: Record<Lang, string> = { zh: 'zh-CN', en: 'en' };
export const OG_LOCALES: Record<Lang, string> = { zh: 'zh_CN', en: 'en_US' };

export const langOf = (path: string): Lang => (path === '/en' || path.startsWith('/en/') ? 'en' : 'zh');
/** 中文路径 → 英文路径（/apps/x/ → /en/apps/x/） */
export const toEn = (zhPath: string) => (zhPath === '/' ? '/en/' : `/en${zhPath}`);
/** 英文路径 → 中文路径 */
export const toZh = (enPath: string) => enPath.replace(/^\/en(?=\/|$)/, '') || '/';

/** 英文版的固定栏目页（列表页、首页、订阅页）；详情页由 enDetailPaths() 按内容补上 */
export const EN_SECTIONS = ['/', '/apps/', '/ai/', '/videos/', '/games/', '/articles/', '/subscribe/'];

type WithEn = { id: string; data: { en?: unknown } };
export function enDetailPaths(c: { apps: WithEn[]; tools: WithEn[]; videos: WithEn[]; games: WithEn[] }) {
  const out: string[] = [];
  for (const [base, list] of [
    ['/apps/', c.apps],
    ['/ai/', c.tools],
    ['/videos/', c.videos],
    ['/games/', c.games],
  ] as const)
    for (const e of list) if (e.data.en) out.push(`${base}${e.id}/`);
  return out;
}

/** 有英文版的中文路径集合 */
export function enPathSet(details: string[]): Set<string> {
  return new Set([...EN_SECTIONS, ...details]);
}

export interface Alternates {
  zh: string;
  en: string;
}
/** 当前页面的双语对应关系：没有对应页面时返回 null（只输出 canonical） */
export function alternatesFor(path: string, enPaths: Set<string>): Alternates | null {
  if (langOf(path) === 'en') {
    const zh = toZh(path);
    return enPaths.has(zh) ? { zh, en: path } : null;
  }
  return enPaths.has(path) ? { zh: path, en: toEn(path) } : null;
}

/** 语言切换链接：有对应页面就去对应页面，否则去另一种语言的首页 */
export function switchHref(path: string, enPaths: Set<string>): string {
  const alt = alternatesFor(path, enPaths);
  if (langOf(path) === 'en') return alt ? alt.zh : '/';
  return alt ? alt.en : '/en/';
}
