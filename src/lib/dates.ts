/**
 * 日期工具：内容日期按北京时间（Asia/Shanghai）理解。
 * 可见文本统一走这里（DESIGN-SYSTEM §18.4，T9.6）：中文「2026年7月19日」、英文「Jul 19, 2026」；
 * 不在可见文本里用 ISO（ISO 只放 <time datetime>）。
 */
import type { Lang } from './i18n';

const TZ = 'Asia/Shanghai';

export function toDate(d: string): Date {
  const [y, m, day = '01'] = d.split('-');
  return new Date(`${y}-${m}-${day}T08:00:00+08:00`);
}

const FULL = {
  zh: new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric' }),
  en: new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' }),
};
const MONTH = {
  zh: new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: 'long' }),
  en: new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short' }),
};

/** 'YYYY-MM-DD' → 2026年7月19日 / Jul 19, 2026；'YYYY-MM' → 2026年7月 / Jul 2026；其他原样返回 */
export function formatDate(d: string | undefined | null, lang: Lang = 'zh'): string {
  if (!d) return '';
  const s = String(d);
  if (/^\d{4}-\d{2}$/.test(s)) return MONTH[lang].format(toDate(s));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return FULL[lang].format(toDate(s.slice(0, 10)));
  return s;
}

/** 'YYYY-MM' 分组键，用于归档 */
export const monthKey = (d: string) => d.slice(0, 7);

export function compareDesc(a: string, b: string): number {
  return toDate(b).getTime() - toDate(a).getTime();
}
