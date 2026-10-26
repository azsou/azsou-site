/**
 * CSV 导出：RFC 4180 转义（逗号 / 引号 / 换行），UTF-8 BOM（Excel 正确识别中文），
 * 并防公式注入：以 = + - @ 制表符 回车 开头的单元格前加单引号（OWASP CSV Injection）。
 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[], bom = true): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
  return (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
}
