/**
 * 管理后台（P4）的数据接口：只经 PostgREST 调用 0009 的 RPC 与有 RLS 保护的表。
 * 权限全部由数据库判定（版主 / 管理员）；这里不做任何「信任前端」的判断。
 */
import { pageKeyUrl, url } from '@/lib/routes';
import {
  categoryId,
  categoryName,
  type Author,
  type Report,
  type ReportStatus,
  type ReportTarget,
  type Role,
  type ThreadFlags,
} from './types';

export type ContentType = 'thread' | 'reply' | 'comment';
export type ModAction = 'none' | 'hide' | 'lock' | 'ban' | 'warn';

export interface Listed<T> {
  items: T[];
  total: number;
}

export interface AdminStats {
  users: number;
  banned: number;
  moderators: number;
  admins: number;
  threads: number;
  threadsHidden: number;
  replies: number;
  repliesHidden: number;
  comments: number;
  commentsHidden: number;
  reportsOpen: number;
  signups7: number;
  signups30: number;
  daily: { day: string; signups: number; posts: number }[];
  generatedAt: string;
}

export interface ContentRow {
  id: string;
  type: ContentType;
  /** 主题标题；回复 = 所属主题标题；评论 = page_key */
  title: string;
  excerpt: string;
  /** 分类 id（回复取所属主题的分类；评论为 null） */
  category: string | null;
  threadKey: string | null;
  pageKey: string | null;
  author: Author;
  published: boolean;
  pinned: boolean;
  locked: boolean;
  featured: boolean;
  createdAt: string;
  editedAt: string | null;
  openReports: number;
  href: string | null;
}

export interface ContentQuery {
  type: ContentType;
  q?: string;
  category?: string;
  hidden?: boolean;
  reported?: boolean;
  author?: string;
  limit?: number;
  offset?: number;
}

export interface AdminUser {
  id: string;
  displayName: string;
  role: Role;
  banned: boolean;
  createdAt: string;
  /** 仅管理员可见；版主为 null */
  email: string | null;
  threads: number;
  replies: number;
  comments: number;
  reportsAgainst: number;
  banReason: string | null;
  banExpiresAt: string | null;
}

export interface UserQuery {
  q?: string;
  role?: Role;
  banned?: boolean;
  limit?: number;
  offset?: number;
}

export interface BanRecord {
  id: number;
  reason: string;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftReason: string;
}

export interface AuditEntry {
  id: number;
  actor: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AuditQuery {
  /** 动作前缀，例如 user. / report. / thread.update */
  action?: string;
  actor?: string;
  targetType?: string;
  targetId?: string;
  /** ISO 时间（含） */
  from?: string;
  /** ISO 时间（不含） */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ReportQuery {
  status?: ReportStatus | 'all';
  targetType?: ReportTarget;
  limit?: number;
  offset?: number;
}

export interface TargetPreview {
  type: ReportTarget;
  id: string;
  exists: boolean;
  title: string;
  excerpt: string;
  author: Author;
  published: boolean;
  locked: boolean;
  href: string | null;
}

export interface SettingRow {
  slug: string;
  data: Record<string, unknown>;
  published: boolean;
  updatedAt: string | null;
}

export type ExportTable = 'forum_threads' | 'forum_replies' | 'comments' | 'profiles';

/** 导出列：不含任何邮箱 / 认证信息（profiles 表本身没有邮箱） */
export const EXPORT_COLUMNS: Record<ExportTable, string> = {
  forum_threads: 'id,cat,title,body,author,pinned,locked,featured,published,created_at,edited_at',
  forum_replies: 'id,thread_id,body,author,published,created_at,edited_at',
  comments: 'id,page_key,body,author,published,created_at,edited_at',
  profiles: 'id,display_name,role,banned,created_at',
};

export interface AdminRepo {
  stats(): Promise<AdminStats>;
  listContent(q: ContentQuery): Promise<Listed<ContentRow>>;
  /** 批量隐藏 / 恢复；返回受影响行数 */
  setPublished(type: ContentType, ids: string[], published: boolean): Promise<number>;
  setThreadFlags(ids: string[], flags: Omit<ThreadFlags, 'published'>): Promise<number>;
  deleteContent(type: ContentType, ids: string[]): Promise<number>;
  listReports(q?: ReportQuery): Promise<Listed<Report>>;
  /** 举报目标预览；键为 `${type}:${id}` */
  previews(targets: { type: ReportTarget; id: string }[]): Promise<Record<string, TargetPreview>>;
  handleReports(
    ids: string[],
    status: Exclude<ReportStatus, 'open'>,
    opts?: { note?: string; action?: ModAction; banDays?: number | null },
  ): Promise<number>;
  listUsers(q?: UserQuery): Promise<Listed<AdminUser>>;
  getUser(id: string): Promise<AdminUser | null>;
  bans(userId: string): Promise<BanRecord[]>;
  /** 管理员：改角色（admin_set_user，保留当前封禁状态） */
  setRole(userId: string, role: Role, banned: boolean): Promise<void>;
  ban(userId: string, reason: string, expiresAt: string | null): Promise<void>;
  unban(userId: string, reason?: string): Promise<void>;
  warn(userId: string, message: string, target?: { type: string; id: string }): Promise<void>;
  liftExpiredBans(): Promise<number>;
  audit(q?: AuditQuery): Promise<Listed<AuditEntry>>;
  /** id → 昵称 */
  names(ids: string[]): Promise<Record<string, string>>;
  settings(): Promise<SettingRow[]>;
  saveSetting(slug: string, data: Record<string, unknown>, published?: boolean): Promise<SettingRow>;
  /** 分页拉取整张表（导出用） */
  exportRows(table: ExportTable, onProgress?: (n: number) => void): Promise<Record<string, unknown>[]>;
}

type Row = Record<string, unknown> & { profiles?: { display_name?: string | null } | null };
export interface AdminRest {
  rest<T = Row[]>(
    path: string,
    init?: { method?: string; body?: unknown; prefer?: string; requireAuth?: boolean },
  ): Promise<T>;
  restCount(path: string, init?: { prefer?: string }): Promise<{ rows: Row[]; total: number }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;
const num = (v: unknown) => Number(v) || 0;
const str = (v: unknown) => (v == null ? '' : String(v));
const clamp = (n: number | undefined, d: number, max = 100) => Math.min(Math.max(Math.trunc(n ?? d), 1), max);
const off = (n: number | undefined) => Math.max(0, Math.trunc(n ?? 0));
/** PostgREST in.(…) 列表：只放合法 uuid */
export const uuidList = (ids: string[]) => [...new Set(ids)].filter((x) => UUID.test(x)).slice(0, 100);
const TABLE: Record<ContentType, string> = {
  thread: 'forum_threads',
  reply: 'forum_replies',
  comment: 'comments',
};

export function contentHref(
  type: ContentType | ReportTarget,
  id: string,
  threadKey?: string | null,
  pageKey?: string | null,
) {
  if (type === 'thread') return url.forumThread(id);
  if (type === 'reply') return threadKey ? `${url.forumThread(threadKey)}#r-${id}` : null;
  if (type === 'comment') return pageKey ? pageKeyUrl(pageKey) : null;
  return url.user(id);
}

export function toContentRow(r: Row): ContentRow {
  const type = str(r.kind) as ContentType;
  return {
    id: str(r.id),
    type,
    title: str(r.title),
    excerpt: str(r.excerpt),
    category: r.cat ? categoryId(str(r.cat)) : null,
    threadKey: (r.thread_key as string) ?? null,
    pageKey: (r.page_key as string) ?? null,
    author: { id: (r.author as string) ?? null, name: str(r.author_name) || '已注销用户' },
    published: r.published !== false,
    pinned: !!r.pinned,
    locked: !!r.locked,
    featured: !!r.featured,
    createdAt: str(r.created_at),
    editedAt: (r.edited_at as string) ?? null,
    openReports: num(r.open_reports),
    href: contentHref(type, str(r.id), r.thread_key as string, r.page_key as string),
  };
}

export function toAdminUser(r: Row): AdminUser {
  return {
    id: str(r.id),
    displayName: str(r.display_name),
    role: (['user', 'moderator', 'admin'].includes(str(r.role)) ? r.role : 'user') as Role,
    banned: !!r.banned,
    createdAt: str(r.created_at),
    email: (r.email as string) ?? null,
    threads: num(r.threads),
    replies: num(r.replies),
    comments: num(r.comments),
    reportsAgainst: num(r.reports_against),
    banReason: (r.ban_reason as string) ?? null,
    banExpiresAt: (r.ban_expires_at as string) ?? null,
  };
}

export function toStats(s: Record<string, unknown>): AdminStats {
  const daily = Array.isArray(s.daily) ? (s.daily as Record<string, unknown>[]) : [];
  return {
    users: num(s.users),
    banned: num(s.banned),
    moderators: num(s.moderators),
    admins: num(s.admins),
    threads: num(s.threads),
    threadsHidden: num(s.threads_hidden),
    replies: num(s.replies),
    repliesHidden: num(s.replies_hidden),
    comments: num(s.comments),
    commentsHidden: num(s.comments_hidden),
    reportsOpen: num(s.reports_open),
    signups7: num(s.signups_7),
    signups30: num(s.signups_30),
    daily: daily.map((d) => ({ day: str(d.day), signups: num(d.signups), posts: num(d.posts) })),
    generatedAt: str(s.generated_at),
  };
}

const toReport = (r: Row): Report => ({
  id: str(r.id),
  reporter: (r.reporter as string) ?? null,
  targetType: r.target_type as Report['targetType'],
  targetId: str(r.target_id),
  reason: r.reason as Report['reason'],
  detail: str(r.detail),
  status: r.status as Report['status'],
  resolutionNote: str(r.resolution_note),
  createdAt: str(r.created_at),
  resolvedAt: (r.resolved_at as string) ?? null,
});

const toAudit = (r: Row): AuditEntry => ({
  id: num(r.id),
  actor: (r.actor as string) ?? null,
  actorRole: (r.actor_role as string) ?? null,
  action: str(r.action),
  targetType: (r.target_type as string) ?? null,
  targetId: (r.target_id as string) ?? null,
  detail: (r.detail as Record<string, unknown>) ?? {},
  createdAt: str(r.created_at),
});

/** PostgREST 过滤值：去掉会破坏语法的字符 */
const safe = (v: string) => v.replace(/[,()"\\*]/g, ' ').trim();

export function auditPath(q: AuditQuery = {}): string {
  const f: string[] = ['select=*', 'order=created_at.desc,id.desc'];
  if (q.action) f.push(`action=like.${enc(`${safe(q.action)}*`)}`);
  if (q.actor && UUID.test(q.actor)) f.push(`actor=eq.${q.actor}`);
  if (q.targetType) f.push(`target_type=eq.${enc(safe(q.targetType))}`);
  if (q.targetId) f.push(`target_id=eq.${enc(safe(q.targetId))}`);
  if (q.from && !Number.isNaN(Date.parse(q.from)))
    f.push(`created_at=gte.${enc(new Date(q.from).toISOString())}`);
  if (q.to && !Number.isNaN(Date.parse(q.to))) f.push(`created_at=lt.${enc(new Date(q.to).toISOString())}`);
  f.push(`limit=${clamp(q.limit, 50, 1000)}`, `offset=${off(q.offset)}`);
  return `audit_log?${f.join('&')}`;
}

export function createAdminApi({ rest, restCount }: AdminRest): AdminRepo {
  const rpc = <T>(name: string, body: Record<string, unknown> = {}) =>
    rest<T>(`rpc/${name}`, { method: 'POST', body, requireAuth: true });

  const bulk = async (path: string, method: 'PATCH' | 'DELETE', body?: unknown) => {
    const rows = await rest<Row[]>(path, {
      method,
      body,
      prefer: 'return=representation',
      requireAuth: true,
    });
    return rows?.length ?? 0;
  };

  return {
    async stats() {
      return toStats(await rpc<Record<string, unknown>>('admin_stats'));
    },
    async listContent(q) {
      const rows = await rpc<Row[]>('mod_list_content', {
        p_type: q.type,
        p_q: q.q?.trim() || null,
        p_cat: q.category ? categoryName(q.category) : null,
        p_hidden: q.hidden ?? null,
        p_reported: q.reported ?? null,
        p_author: q.author && UUID.test(q.author) ? q.author : null,
        p_limit: clamp(q.limit, 25),
        p_offset: off(q.offset),
      });
      return { items: (rows ?? []).map(toContentRow), total: num(rows?.[0]?.total) };
    },
    async setPublished(type, ids, published) {
      const list = uuidList(ids);
      if (!list.length) return 0;
      return bulk(`${TABLE[type]}?id=in.(${list.join(',')})&select=id`, 'PATCH', { published });
    },
    async setThreadFlags(ids, flags) {
      const list = uuidList(ids);
      if (!list.length) return 0;
      const body: Record<string, boolean> = {};
      for (const k of ['pinned', 'locked', 'featured'] as const)
        if (flags[k] !== undefined) body[k] = !!flags[k];
      return bulk(`forum_threads?id=in.(${list.join(',')})&select=id`, 'PATCH', body);
    },
    async deleteContent(type, ids) {
      const list = uuidList(ids);
      if (!list.length) return 0;
      return bulk(`${TABLE[type]}?id=in.(${list.join(',')})&select=id`, 'DELETE');
    },
    async listReports(q = {}) {
      const f = ['select=*'];
      const status = q.status ?? 'open';
      if (status !== 'all') f.push(`status=eq.${status}`);
      if (q.targetType) f.push(`target_type=eq.${q.targetType}`);
      f.push(status === 'open' ? 'order=created_at.asc,id.asc' : 'order=created_at.desc,id.desc');
      f.push(`limit=${clamp(q.limit, 25)}`, `offset=${off(q.offset)}`);
      const { rows, total } = await restCount(`reports?${f.join('&')}`);
      return { items: rows.map(toReport), total };
    },
    async previews(targets) {
      const out: Record<string, TargetPreview> = {};
      const by = (t: ReportTarget) => uuidList(targets.filter((x) => x.type === t).map((x) => x.id));
      const missing = (type: ReportTarget, id: string): TargetPreview => ({
        type,
        id,
        exists: false,
        title: '',
        excerpt: '内容已被删除',
        author: { id: null, name: '—' },
        published: false,
        locked: false,
        href: null,
      });
      for (const t of targets) out[`${t.type}:${t.id}`] = missing(t.type, t.id);
      const author = (r: Row): Author => ({
        id: (r.author as string) ?? null,
        name: r.profiles?.display_name || '已注销用户',
      });
      const clip = (s: unknown) => str(s).replace(/\s+/g, ' ').slice(0, 200);
      const [threads, replies, comments, profiles, reviews] = await Promise.all([
        by('thread').length
          ? rest<Row[]>(
              `forum_threads?id=in.(${by('thread').join(',')})&select=id,title,body,author,published,locked,profiles(display_name)`,
              { requireAuth: true },
            )
          : [],
        by('reply').length
          ? rest<Row[]>(
              `forum_replies?id=in.(${by('reply').join(',')})&select=id,thread_id,body,author,published,profiles(display_name)`,
              { requireAuth: true },
            )
          : [],
        by('comment').length
          ? rest<Row[]>(
              `comments?id=in.(${by('comment').join(',')})&select=id,page_key,body,author,published,profiles(display_name)`,
              { requireAuth: true },
            )
          : [],
        by('profile').length
          ? rest<Row[]>(`profiles?id=in.(${by('profile').join(',')})&select=id,display_name,role,banned`, {
              requireAuth: true,
            })
          : [],
        // 应用评价（0012）；旧库没有这张表时当作「已删除」显示
        by('review').length
          ? rest<Row[]>(
              `app_reviews?id=in.(${by('review').join(',')})&select=id,app,rating,title,body,author,published,profiles(display_name)`,
              { requireAuth: true },
            ).catch(() => [] as Row[])
          : [],
      ]);
      for (const r of threads)
        out[`thread:${r.id}`] = {
          type: 'thread',
          id: str(r.id),
          exists: true,
          title: str(r.title),
          excerpt: clip(r.body),
          author: author(r),
          published: r.published !== false,
          locked: !!r.locked,
          href: contentHref('thread', str(r.id)),
        };
      for (const r of replies)
        out[`reply:${r.id}`] = {
          type: 'reply',
          id: str(r.id),
          exists: true,
          title: '回复',
          excerpt: clip(r.body),
          author: author(r),
          published: r.published !== false,
          locked: false,
          href: contentHref('reply', str(r.id), str(r.thread_id)),
        };
      for (const r of comments)
        out[`comment:${r.id}`] = {
          type: 'comment',
          id: str(r.id),
          exists: true,
          title: str(r.page_key),
          excerpt: clip(r.body),
          author: author(r),
          published: r.published !== false,
          locked: false,
          href: contentHref('comment', str(r.id), null, str(r.page_key)),
        };
      for (const r of profiles)
        out[`profile:${r.id}`] = {
          type: 'profile',
          id: str(r.id),
          exists: true,
          title: str(r.display_name),
          excerpt: r.banned ? '已封禁' : `角色：${str(r.role)}`,
          author: { id: str(r.id), name: str(r.display_name) },
          published: true,
          locked: false,
          href: url.adminUser(str(r.id)),
        };
      for (const r of reviews)
        out[`review:${r.id}`] = {
          type: 'review',
          id: str(r.id),
          exists: true,
          title: `${str(r.app)} · ${'★'.repeat(Math.min(5, Math.max(1, num(r.rating))))}`,
          excerpt: clip([str(r.title), str(r.body)].filter(Boolean).join(' — ') || '（只打了星）'),
          author: author(r),
          published: r.published !== false,
          locked: false,
          href: `${url.app(str(r.app))}#review-${str(r.id)}`,
        };
      return out;
    },
    async handleReports(ids, status, opts = {}) {
      const n = await rpc<number>('mod_handle_reports', {
        p_ids: uuidList(ids),
        p_status: status,
        p_note: (opts.note ?? '').trim(),
        p_action: opts.action ?? 'none',
        p_ban_days: opts.banDays ?? null,
      });
      return num(n);
    },
    async listUsers(q = {}) {
      const rows = await rpc<Row[]>('mod_list_users', {
        p_q: q.q?.trim() || null,
        p_role: q.role ?? null,
        p_banned: q.banned ?? null,
        p_limit: clamp(q.limit, 25),
        p_offset: off(q.offset),
      });
      return { items: (rows ?? []).map(toAdminUser), total: num(rows?.[0]?.total) };
    },
    async getUser(id) {
      if (!UUID.test(id)) return null;
      const rows = await rpc<Row[]>('mod_list_users', { p_id: id, p_limit: 1 });
      return rows?.[0] ? toAdminUser(rows[0]) : null;
    },
    async bans(userId) {
      if (!UUID.test(userId)) return [];
      const rows = await rest<Row[]>(
        `user_bans?user_id=eq.${userId}&select=*&order=created_at.desc&limit=50`,
        {
          requireAuth: true,
        },
      );
      return rows.map((r) => ({
        id: num(r.id),
        reason: str(r.reason),
        expiresAt: (r.expires_at as string) ?? null,
        createdBy: (r.created_by as string) ?? null,
        createdAt: str(r.created_at),
        liftedAt: (r.lifted_at as string) ?? null,
        liftedBy: (r.lifted_by as string) ?? null,
        liftReason: str(r.lift_reason),
      }));
    },
    async setRole(userId, role, banned) {
      await rpc('admin_set_user', { target: userId, new_role: role, new_banned: banned });
    },
    async ban(userId, reason, expiresAt) {
      await rpc('mod_ban_user', { p_target: userId, p_reason: reason.trim(), p_expires_at: expiresAt });
    },
    async unban(userId, reason = '') {
      await rpc('mod_unban_user', { p_target: userId, p_reason: reason.trim() });
    },
    async warn(userId, message, target) {
      await rpc('mod_warn_user', {
        p_target: userId,
        p_message: message.trim(),
        p_target_type: target?.type ?? null,
        p_target_id: target?.id ?? null,
      });
    },
    async liftExpiredBans() {
      return num(await rpc<number>('mod_lift_expired_bans'));
    },
    async audit(q = {}) {
      const { rows, total } = await restCount(auditPath(q));
      return { items: rows.map(toAudit), total };
    },
    async names(ids) {
      const list = uuidList(ids);
      if (!list.length) return {};
      const rows = await rest<Row[]>(`profiles?id=in.(${list.join(',')})&select=id,display_name`);
      return Object.fromEntries(rows.map((r) => [str(r.id), str(r.display_name)]));
    },
    async settings() {
      const rows = await rest<Row[]>(
        'site_content?kind=eq.setting&select=slug,data,published,updated_at&order=slug',
        {
          requireAuth: true,
        },
      );
      return rows.map((r) => ({
        slug: str(r.slug),
        data: (r.data as Record<string, unknown>) ?? {},
        published: r.published !== false,
        updatedAt: (r.updated_at as string) ?? null,
      }));
    },
    async saveSetting(slug, data, published = true) {
      const rows = await rest<Row[]>(
        'site_content?on_conflict=kind,slug&select=slug,data,published,updated_at',
        {
          method: 'POST',
          body: { kind: 'setting', slug, data, published },
          prefer: 'resolution=merge-duplicates,return=representation',
          requireAuth: true,
        },
      );
      const r = rows?.[0];
      if (!r) throw new Error('保存失败');
      return {
        slug: str(r.slug),
        data: (r.data as Record<string, unknown>) ?? {},
        published: r.published !== false,
        updatedAt: (r.updated_at as string) ?? null,
      };
    },
    async exportRows(table, onProgress) {
      const out: Record<string, unknown>[] = [];
      const page = 1000;
      for (let offset = 0; offset < 200_000; offset += page) {
        const rows = await rest<Row[]>(
          `${table}?select=${EXPORT_COLUMNS[table]}&order=created_at.asc,id.asc&limit=${page}&offset=${offset}`,
          { requireAuth: true },
        );
        out.push(...rows);
        onProgress?.(out.length);
        if (rows.length < page) break;
      }
      return out;
    },
  };
}
