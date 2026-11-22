/**
 * 后台 CRM 的纯函数（P10 PR H：T10.20 / T10.21），无 DOM，便于单测：
 *  - lineDiff：按行 LCS 对比两个版本（内容版本历史）；
 *  - userSegments：按真实字段给用户分群（新用户 / 活跃 / 被举报 / 已封禁 / 管理团队）；
 *  - fillTemplate：批量邮件草稿的变量替换（只用于预览；后台没有任何发信接口）。
 */
export type DiffOp = { op: 'same' | 'add' | 'del'; text: string };

/** 行级差异（LCS）。超过 800 行时退化为「整段删除 + 整段新增」，避免 O(n²) 卡顿。 */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > 640_000) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  while (i < m) out.push({ op: 'del', text: a[i++] });
  while (j < n) out.push({ op: 'add', text: b[j++] });
  return out;
}

export const diffStats = (ops: DiffOp[]) => ({
  add: ops.filter((o) => o.op === 'add').length,
  del: ops.filter((o) => o.op === 'del').length,
});

export interface SegmentInput {
  role: string;
  banned: boolean;
  createdAt: string;
  threads: number;
  replies: number;
  comments: number;
  reportsAgainst: number;
  /** 近 30 天发布条数（有画像数据时传入） */
  recentPosts?: number;
}
export type Segment = 'new' | 'active' | 'reported' | 'banned' | 'staff' | 'silent';
export const SEGMENT_LABEL: Record<Segment, string> = {
  new: '新用户（30 天内注册）',
  active: '活跃（近 30 天发布 ≥ 3）',
  reported: '被举报',
  banned: '已封禁',
  staff: '管理团队',
  silent: '未发言',
};

const DAY = 86_400_000;
export function userSegments(u: SegmentInput, now = Date.now()): Segment[] {
  const out: Segment[] = [];
  const created = Date.parse(u.createdAt);
  if (!Number.isNaN(created) && now - created < 30 * DAY) out.push('new');
  if ((u.recentPosts ?? 0) >= 3) out.push('active');
  if (u.threads + u.replies + u.comments === 0) out.push('silent');
  if (u.reportsAgainst > 0) out.push('reported');
  if (u.banned) out.push('banned');
  if (u.role === 'admin' || u.role === 'moderator') out.push('staff');
  return out;
}

export const recentCount = (items: { createdAt: string }[], now = Date.now(), days = 30) =>
  items.filter((x) => {
    const t = Date.parse(x.createdAt);
    return !Number.isNaN(t) && now - t < days * DAY;
  }).length;

/** {{name}} / {{role}} 等变量替换；未知变量原样保留，便于在预览里看出拼写错误 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (all, k: string) => (k in vars ? vars[k] : all));
}
