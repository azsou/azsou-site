/** 日期工具：内容日期按北京时间（Asia/Shanghai）理解。 */
export function toDate(d: string): Date {
  const [y, m, day = '01'] = d.split('-');
  return new Date(`${y}-${m}-${day}T08:00:00+08:00`);
}

export function formatDate(d: string): string {
  const parts = d.split('-').map((n) => parseInt(n, 10));
  if (parts.length === 2) return `${parts[0]} 年 ${parts[1]} 月`;
  return `${parts[0]} 年 ${parts[1]} 月 ${parts[2]} 日`;
}

/** 'YYYY-MM' 分组键，用于归档 */
export const monthKey = (d: string) => d.slice(0, 7);

export function compareDesc(a: string, b: string): number {
  return toDate(b).getTime() - toDate(a).getTime();
}
