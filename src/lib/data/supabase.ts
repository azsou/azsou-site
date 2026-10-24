import { localStore, type SessionStore } from './session';
import { createSupabaseAuth } from './supabase-auth';
import {
  categoryId,
  categoryName,
  DataUnavailableError,
  ForbiddenError,
  NotSignedInError,
  RateLimitedError,
  ValidationError,
  type Author,
  type AuthProvider,
  type Comment,
  type DataRepository,
  type LikeSummary,
  type Notification,
  type Profile,
  type Reply,
  type Report,
  type Role,
  type Thread,
} from './types';

/**
 * Supabase 适配器。直接调 PostgREST（/rest/v1）与 GoTrue（/auth/v1），不引 supabase-js（首屏 JS 预算）。
 * 只用标准 REST 查询；表结构见 db/migrations（与 V72 共用同一套表）。
 */
export interface SupabaseConfig {
  url: string;
  key: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  store?: SessionStore;
  /** 见 SupabaseAuthConfig.guardedEndpoint */
  guardedEndpoint?: string;
  /** 测试注入 */
  auth?: AuthProvider;
}

type Row = Record<string, unknown> & { profiles?: { display_name?: string | null } | null };

const author = (r: Row): Author => ({
  id: (r.author as string) ?? null,
  name: r.profiles?.display_name || '匿名用户',
});

const toThread = (r: Row): Thread => ({
  id: String(r.id),
  category: categoryId(String(r.cat ?? '')),
  title: String(r.title ?? ''),
  body: String(r.body ?? ''),
  author: author(r),
  pinned: !!r.pinned,
  locked: !!r.locked,
  featured: !!r.featured,
  published: r.published !== false,
  createdAt: String(r.created_at),
  editedAt: (r.edited_at as string) ?? null,
});

const toReply = (r: Row): Reply => ({
  id: String(r.id),
  threadId: String(r.thread_id),
  body: String(r.body ?? ''),
  author: author(r),
  createdAt: String(r.created_at),
  editedAt: (r.edited_at as string) ?? null,
  published: r.published !== false,
});

const toComment = (r: Row): Comment => ({
  id: String(r.id),
  pageKey: String(r.page_key),
  body: String(r.body ?? ''),
  author: author(r),
  createdAt: String(r.created_at),
  editedAt: (r.edited_at as string) ?? null,
  published: r.published !== false,
});

const toProfile = (r: Row): Profile => ({
  id: String(r.id),
  displayName: String(r.display_name ?? ''),
  role: (['user', 'moderator', 'admin'].includes(String(r.role)) ? r.role : 'user') as Role,
  banned: !!r.banned,
  createdAt: String(r.created_at),
});

const toReport = (r: Row): Report => ({
  id: String(r.id),
  reporter: (r.reporter as string) ?? null,
  targetType: r.target_type as Report['targetType'],
  targetId: String(r.target_id),
  reason: r.reason as Report['reason'],
  detail: String(r.detail ?? ''),
  status: r.status as Report['status'],
  resolutionNote: String(r.resolution_note ?? ''),
  createdAt: String(r.created_at),
  resolvedAt: (r.resolved_at as string) ?? null,
});

const toNotification = (r: Row & { actor?: { display_name?: string } | null }): Notification => ({
  id: Number(r.id),
  kind: r.kind as Notification['kind'],
  actorName: r.actor?.display_name ?? null,
  threadKey: (r.thread_key as string) ?? null,
  targetType: (r.target_type as string) ?? null,
  targetId: (r.target_id as string) ?? null,
  excerpt: String(r.excerpt ?? ''),
  read: !!r.read_at,
  createdAt: String(r.created_at),
});

// 新列（locked / featured / edited_at）来自 0002 迁移；生产库迁移前（Vercel 预览直连生产库）
// PostgREST 会回 42703（列不存在），读取时自动退回 V72 的列，预览站照常可读。
const LEGACY = {
  thread: 'id,cat,title,body,author,pinned,published,created_at,profiles(display_name)',
  reply: 'id,thread_id,body,author,published,created_at,profiles(display_name)',
  comment: 'id,page_key,body,author,published,created_at,profiles(display_name)',
};
class MissingColumnError extends Error {}
const THREAD_COLS =
  'id,cat,title,body,author,pinned,locked,featured,published,created_at,edited_at,profiles(display_name)';
const REPLY_COLS = 'id,thread_id,body,author,published,created_at,edited_at,profiles(display_name)';
const COMMENT_COLS = 'id,page_key,body,author,published,created_at,edited_at,profiles(display_name)';
const NOTIF_COLS =
  'id,kind,excerpt,read_at,created_at,thread_key,target_type,target_id,actor:profiles!notifications_actor_fkey(display_name)';

/** PostgREST 错误 → 仓储错误 */
export function restError(status: number, body: Record<string, unknown> | null): Error {
  const code = String(body?.code ?? '');
  const msg = String(body?.message ?? '');
  const hint = body?.hint ? String(body.hint) : '';
  if (status === 429 || code === 'PT429') return new RateLimitedError(hint || undefined);
  if (code === '42501' || status === 401 || status === 403) {
    // 触发器给出的中文原因（az_forbid）直接展示；RLS 的英文提示换成通用中文
    return new ForbiddenError(/[\u4e00-\u9fff]/.test(msg) ? msg : undefined);
  }
  if (code === '23503')
    return new ValidationError(/[\u4e00-\u9fff]/.test(msg) ? msg : '目标不存在或已被删除');
  if (code === '23505') return new ValidationError('已经提交过了');
  if (code === '23514' || code === '22001') return new ValidationError('内容长度或格式不符合要求');
  if (status >= 500) return new DataUnavailableError(`HTTP ${status}`);
  return new Error(msg || `HTTP ${status}`);
}

export function createSupabaseRepository(cfg: SupabaseConfig): DataRepository {
  const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const auth =
    cfg.auth ??
    createSupabaseAuth({
      url: cfg.url,
      key: cfg.key,
      store: cfg.store ?? localStore(),
      fetch: f,
      guardedEndpoint: cfg.guardedEndpoint,
    });

  async function rest<T = Row[]>(
    path: string,
    init: { method?: string; body?: unknown; prefer?: string; requireAuth?: boolean } = {},
  ): Promise<T> {
    const token = await auth.accessToken().catch(() => null);
    if (init.requireAuth && !token) throw new NotSignedInError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8000);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        apikey: cfg.key,
        Authorization: `Bearer ${token ?? cfg.key}`,
      };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      if (init.prefer) headers.Prefer = init.prefer;
      res = await f(`${cfg.url}/rest/v1/${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DataUnavailableError((e as Error)?.message);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return null as T;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new DataUnavailableError('响应不是 JSON');
    }
    if (!res.ok) {
      if ((json as { code?: string } | null)?.code === '42703') throw new MissingColumnError();
      throw restError(res.status, json as Record<string, unknown>);
    }
    return json as T;
  }
  /** 读：先用新列，库还没迁移时退回旧列 */
  async function read(build: (cols: string) => string, cols: string, legacy: string): Promise<Row[]> {
    try {
      return await rest(build(cols));
    } catch (e) {
      if (e instanceof MissingColumnError) return rest(build(legacy));
      throw e;
    }
  }

  const uid = () => {
    const s = auth.getSession();
    if (!s) throw new NotSignedInError();
    return s.user.id;
  };
  const enc = encodeURIComponent;
  const RET = 'return=representation';
  /** 写操作返回 0 行 = RLS 把目标行过滤掉了（不是作者 / 不是版主 / 已删除） */
  const one = <T>(rows: Row[] | null, map: (r: Row) => T): T => {
    if (!rows?.length) throw new ForbiddenError('没有权限，或内容已被删除');
    return map(rows[0]);
  };

  return {
    name: 'supabase',
    auth,
    profiles: {
      async get(id) {
        const rows = await rest(`profiles?id=eq.${enc(id)}&select=id,display_name,role,banned,created_at`);
        return rows[0] ? toProfile(rows[0]) : null;
      },
      async me() {
        const s = auth.getSession();
        if (!s) return null;
        return this.get(s.user.id);
      },
      async updateDisplayName(name) {
        const rows = await rest(
          `profiles?id=eq.${enc(uid())}&select=id,display_name,role,banned,created_at`,
          {
            method: 'PATCH',
            body: { display_name: name.trim() },
            prefer: RET,
            requireAuth: true,
          },
        );
        return one(rows, toProfile);
      },
    },
    forum: {
      async listThreads(opts = {}) {
        const cat = opts.category ? `&cat=eq.${enc(categoryName(opts.category))}` : '';
        const rows = await read(
          (c) =>
            `forum_threads?select=${c}&published=eq.true${cat}&order=pinned.desc,created_at.desc&limit=${opts.limit ?? 200}`,
          THREAD_COLS,
          LEGACY.thread,
        );
        return rows.map(toThread).filter((t) => !opts.category || t.category === opts.category);
      },
      async getThread(id) {
        const rows = await read(
          (c) => `forum_threads?select=${c}&id=eq.${enc(id)}&limit=1`,
          THREAD_COLS,
          LEGACY.thread,
        );
        return rows[0] ? toThread(rows[0]) : null;
      },
      async listReplies(threadId) {
        const rows = await read(
          (c) =>
            `forum_replies?thread_id=eq.${enc(threadId)}&published=eq.true&select=${c}&order=created_at.asc`,
          REPLY_COLS,
          LEGACY.reply,
        );
        return rows.map(toReply);
      },
      async replyCounts() {
        const rows = await rest<{ thread_id: string }[]>(
          'forum_replies?select=thread_id&published=eq.true&limit=5000',
        );
        const m: Record<string, number> = {};
        for (const r of rows) if (r.thread_id) m[r.thread_id] = (m[r.thread_id] ?? 0) + 1;
        return m;
      },
      async createThread(input) {
        const rows = await rest(`forum_threads?select=${THREAD_COLS}`, {
          method: 'POST',
          body: {
            cat: categoryName(input.category),
            title: input.title.trim(),
            body: input.body.trim(),
            author: uid(),
          },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toThread);
      },
      async updateThread(id, patch) {
        const body: Record<string, string> = {};
        if (patch.title !== undefined) body.title = patch.title.trim();
        if (patch.body !== undefined) body.body = patch.body.trim();
        if (patch.category !== undefined) body.cat = categoryName(patch.category);
        const rows = await rest(`forum_threads?id=eq.${enc(id)}&select=${THREAD_COLS}`, {
          method: 'PATCH',
          body,
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toThread);
      },
      async deleteThread(id) {
        const rows = await rest(`forum_threads?id=eq.${enc(id)}&select=id`, {
          method: 'DELETE',
          prefer: RET,
          requireAuth: true,
        });
        one(rows, (r) => r);
      },
      async setThreadFlags(id, flags) {
        const rows = await rest(`forum_threads?id=eq.${enc(id)}&select=${THREAD_COLS}`, {
          method: 'PATCH',
          body: flags,
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toThread);
      },
      async reply(threadId, body) {
        const rows = await rest(`forum_replies?select=${REPLY_COLS}`, {
          method: 'POST',
          body: { thread_id: threadId, body: body.trim(), author: uid() },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toReply);
      },
      async updateReply(id, body) {
        const rows = await rest(`forum_replies?id=eq.${enc(id)}&select=${REPLY_COLS}`, {
          method: 'PATCH',
          body: { body: body.trim() },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toReply);
      },
      async deleteReply(id) {
        const rows = await rest(`forum_replies?id=eq.${enc(id)}&select=id`, {
          method: 'DELETE',
          prefer: RET,
          requireAuth: true,
        });
        one(rows, (r) => r);
      },
      async like(targetType, id) {
        try {
          await rest('likes', {
            method: 'POST',
            body: { user_id: uid(), target_type: targetType, target_id: id },
            prefer: 'return=minimal',
            requireAuth: true,
          });
        } catch (e) {
          if (!(e instanceof ValidationError && e.message === '已经提交过了')) throw e;
        }
      },
      async unlike(targetType, id) {
        await rest(`likes?user_id=eq.${enc(uid())}&target_type=eq.${targetType}&target_id=eq.${enc(id)}`, {
          method: 'DELETE',
          requireAuth: true,
        });
      },
      async likeSummary(targetType, ids) {
        if (!ids.length) return {};
        const rows = await rest<{ target_id: string; likes: number; liked: boolean | null }[]>(
          'rpc/like_summary',
          {
            method: 'POST',
            body: { p_target_type: targetType, p_ids: ids },
          },
        );
        const out: Record<string, LikeSummary> = {};
        for (const id of ids) out[id] = { likes: 0, liked: false };
        for (const r of rows ?? []) out[r.target_id] = { likes: Number(r.likes) || 0, liked: !!r.liked };
        return out;
      },
    },
    comments: {
      async list(pageKey) {
        const rows = await read(
          (c) => `comments?page_key=eq.${enc(pageKey)}&published=eq.true&select=${c}&order=created_at.asc`,
          COMMENT_COLS,
          LEGACY.comment,
        );
        return rows.map(toComment);
      },
      async create(pageKey, body) {
        const rows = await rest(`comments?select=${COMMENT_COLS}`, {
          method: 'POST',
          body: { page_key: pageKey, body: body.trim(), author: uid() },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toComment);
      },
      async update(id, body) {
        const rows = await rest(`comments?id=eq.${enc(id)}&select=${COMMENT_COLS}`, {
          method: 'PATCH',
          body: { body: body.trim() },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toComment);
      },
      async remove(id) {
        const rows = await rest(`comments?id=eq.${enc(id)}&select=id`, {
          method: 'DELETE',
          prefer: RET,
          requireAuth: true,
        });
        one(rows, (r) => r);
      },
    },
    reports: {
      async create(input) {
        const rows = await rest('reports?select=*', {
          method: 'POST',
          body: {
            reporter: uid(),
            target_type: input.targetType,
            target_id: input.targetId,
            reason: input.reason,
            detail: (input.detail ?? '').trim(),
          },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toReport);
      },
      async listMine() {
        const rows = await rest(`reports?reporter=eq.${enc(uid())}&select=*&order=created_at.desc`, {
          requireAuth: true,
        });
        return rows.map(toReport);
      },
      async listOpen() {
        const rows = await rest('reports?status=eq.open&select=*&order=created_at.asc&limit=200', {
          requireAuth: true,
        });
        return rows.map(toReport);
      },
      async resolve(id, status, note = '') {
        const rows = await rest(`reports?id=eq.${enc(id)}&select=*`, {
          method: 'PATCH',
          body: { status, resolution_note: note.trim() },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toReport);
      },
    },
    notifications: {
      async list(opts = {}) {
        const rows = await rest(
          `notifications?select=${NOTIF_COLS}&order=created_at.desc&limit=${opts.limit ?? 50}`,
          {
            requireAuth: true,
          },
        );
        return rows.map(toNotification);
      },
      async unreadCount() {
        if (!auth.getSession()) return 0;
        const n = await rest<number>('rpc/unread_notification_count', {
          method: 'POST',
          body: {},
          requireAuth: true,
        });
        return Number(n) || 0;
      },
      async markRead(ids) {
        const n = await rest<number>('rpc/mark_notifications_read', {
          method: 'POST',
          body: { p_ids: ids ?? null },
          requireAuth: true,
        });
        return Number(n) || 0;
      },
    },
  };
}
