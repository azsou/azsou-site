/** 后台的纯函数工具（可单元测试）。 */

export const BAN_DURATIONS: [string, string][] = [
  ['1', '1 天'],
  ['3', '3 天'],
  ['7', '7 天'],
  ['30', '30 天'],
  ['', '永久'],
  ['custom', '自定义到期时间'],
];

/** 封禁到期时间：天数或自定义 datetime-local（按浏览器本地时区解释）；'' = 永久 → null */
export function banExpiry(choice: string, custom: string, now = Date.now()): string | null | Error {
  if (choice === '') return null;
  if (choice === 'custom') {
    const t = Date.parse(custom);
    if (!custom || Number.isNaN(t)) return new Error('请选择到期时间。');
    if (t <= now) return new Error('到期时间必须晚于现在。');
    return new Date(t).toISOString();
  }
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return new Error('封禁时长不正确。');
  return new Date(now + days * 86_400_000).toISOString();
}

/** 审计详情 → 一行摘要（表格里显示；完整 JSON 在 CSV 里） */
export function auditSummary(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const d = detail ?? {};
  const fmt = (v: unknown) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (d.from && d.to) parts.push(`${fmt(d.from)} → ${fmt(d.to)}`);
  if (typeof d.reason === 'string' && d.reason) parts.push(`原因：${d.reason}`);
  if (typeof d.note === 'string' && d.note) parts.push(`说明：${d.note}`);
  if (typeof d.message === 'string' && d.message) parts.push(`内容：${d.message}`);
  if (d.expires_at) parts.push(`到期：${fmt(d.expires_at)}`);
  if (d.ban_days) parts.push(`${fmt(d.ban_days)} 天`);
  if (d.changes && typeof d.changes === 'object') {
    const ch = Object.entries(d.changes as Record<string, unknown>).map(([k, v]) =>
      v && typeof v === 'object' && 'to' in (v as object)
        ? `${k}=${fmt((v as { to: unknown }).to)}`
        : `${k}:${fmt(v)}`,
    );
    if (ch.length) parts.push(ch.join('，'));
  }
  if (!parts.length) {
    const rest = Object.entries(d).filter(([, v]) => v != null && v !== '');
    if (rest.length) parts.push(rest.map(([k, v]) => `${k}=${fmt(v)}`).join('，'));
  }
  return parts.join(' · ').slice(0, 300);
}
