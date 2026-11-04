import { localStore, type SessionStore } from './session';
import { createSupabaseAuth } from './supabase-auth';
import { IMAGE_BUCKET, objectPath, publicImageUrl } from '../images';
import {
  categoryId,
  categoryName,
  DataUnavailableError,
  ForbiddenError,
  NotSignedInError,
  RateLimitedError,
  SchemaMissingError,
  objectFromPath,
  ValidationError,
  type Author,
  type AuthProvider,
  type Comment,
  type DataRepository,
  type Bookmark,
  type LikeSummary,
  type Page,
  type SearchHit,
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
/** 旧库（生产迁移前）没有这一列：42703。path = 出错的 PostgREST 路径 */
class MissingColumnError extends Error {
  constructor(readonly path = '') {
    super('42703');
  }
}
/** 旧库（生产迁移前）没有这个 RPC / 表：PGRST202 / PGRST205 */
class MissingObjectError extends Error {
  constructor(
    readonly code: string,
    readonly path = '',
  ) {
    super(code);
  }
}
/**
 * 内部「缺对象 / 缺列」→ 对外的 SchemaMissingError（带对象名）。
 * 迁移编号不在这里查：编号表（schema-map.ts）只进后台的包——后台接口（admin-repo.ts）与后台错误提示（admin-errors.ts）补上编号。
 */
export function schemaMissing(path: string, code: string): SchemaMissingError {
  return new SchemaMissingError(objectFromPath(path), code);
}

/** 游标：`<created_at>|<id>`（keyset 分页，新内容插入不会造成重复或漏项） */
export const encodeCursor = (createdAt: string, id: string) => `${createdAt}|${id}`;
export function decodeCursor(c: string | null | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('|');
  if (i <= 0) return null;
  const at = c.slice(0, i);
  const id = c.slice(i + 1);
  if (Number.isNaN(Date.parse(at)) || !/^[0-9a-zA-Z-]{1,64}$/.test(id)) return null;
  return { at, id };
}
/** PostgREST 逻辑树里的值加双引号（时间戳含 . : +） */
const q = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
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
  if (status === 429 || code === 'PT429')
    return new RateLimitedError(hint || undefined, body?.details ? String(body.details) : '');
  if (code === '42501' || status === 401 || status === 403) {
    // 触发器给出的中文原因（az_forbid）直接展示；RLS 的英文提示换成通用中文
    return new ForbiddenError(/[\u4e00-\u9fff]/.test(msg) ? msg : undefined);
  }
  if (code === '23503')
    return new ValidationError(/[\u4e00-\u9fff]/.test(msg) ? msg : '目标不存在或已被删除');
  if (code === '23505') return new ValidationError('已经提交过了');
  if (code === '23514' || code === '22001')
    return new ValidationError(/[\u4e00-\u9fff]/.test(msg) ? msg : '内容长度或格式不符合要求');
  // 后台 RPC 的参数错误 / 目标不存在（0009，中文提示）
  if ((code === '22023' || code === 'P0002') && /[\u4e00-\u9fff]/.test(msg)) return new ValidationError(msg);
  if (status >= 500) return new DataUnavailableError(`HTTP ${status}`, { kind: 'server', status });
  return new Error(msg || `HTTP ${status}`);
}

const blobBytes = (b: Blob): Promise<ArrayBuffer> =>
  typeof b.arrayBuffer === 'function'
    ? b.arrayBuffer()
    : new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(b);
      });

/** Storage API 错误 → 中文错误（storage-api 返回 { statusCode, error, message }） */
export function storageError(status: number, body: Record<string, unknown> | null): Error {
  const msg = String(body?.message ?? body?.error ?? '');
  const code = Number(body?.statusCode ?? status);
  if (status === 413 || code === 413 || /size|too large|exceed/i.test(msg))
    return new ValidationError('图片超过 2 MB，请换一张或缩小后再试');
  if (status === 415 || code === 415 || /mime|content type/i.test(msg))
    return new ValidationError('只支持 JPG、PNG、WebP、GIF 图片');
  if (status === 429) return new RateLimitedError('上传太频繁，请稍后再试');
  if (status === 401 && !/row-level security/i.test(msg))
    return new NotSignedInError('登录已过期，请重新登录');
  if (status === 401 || status === 403 || /row-level security|unauthori[sz]ed/i.test(msg))
    return new ForbiddenError('无法上传：账户受限，或上传太频繁（10 分钟最多 10 张、每天最多 50 张）');
  if (status === 409 || /duplicate|already exists/i.test(msg))
    return new ValidationError('同名图片已存在，请重试');
  if (status === 404 && /bucket/i.test(msg))
    return new DataUnavailableError('图片存储还没有开通（缺少 ugc-images 桶）');
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

  async function request(
    path: string,
    init: { method?: string; body?: unknown; prefer?: string; requireAuth?: boolean } = {},
  ): Promise<{ json: unknown; res: Response }> {
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
      throw new DataUnavailableError((e as Error)?.message, {
        kind: ctrl.signal.aborted ? 'timeout' : 'network',
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return { json: null, res };
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok)
        throw new DataUnavailableError('响应不是 JSON', { kind: 'bad-response', status: res.status });
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code;
      if (code === '42703') throw new MissingColumnError(path);
      if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01')
        throw new MissingObjectError(code, path);
      throw restError(res.status, json as Record<string, unknown>);
    }
    return { json, res };
  }
  async function rest<T = Row[]>(
    path: string,
    init: { method?: string; body?: unknown; prefer?: string; requireAuth?: boolean } = {},
  ): Promise<T> {
    return (await request(path, init)).json as T;
  }
  /** GET + 总数（Prefer: count=exact → Content-Range: 0-24/123） */
  async function restCount(path: string, init: { prefer?: string } = {}) {
    const { json, res } = await request(path, {
      requireAuth: true,
      prefer: ['count=exact', init.prefer].filter(Boolean).join(','),
    });
    const rows = (Array.isArray(json) ? json : []) as Row[];
    const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    return { rows, total: m ? Number(m[1]) : rows.length };
  }
  /** 后台接口：旧库上给出「缺哪个对象 / 哪个迁移」的明确错误（A15），不再归为网络问题 */
  const notMigrated = (e: unknown): never => {
    if (e instanceof MissingObjectError) throw schemaMissing(e.path, e.code);
    if (e instanceof MissingColumnError) throw schemaMissing(e.path, '42703');
    throw e;
  };
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

  /** 列表分页：多取一行判断是否还有下一页 */
  const paged = <T extends { createdAt: string; id: string }>(rows: T[], limit: number): Page<T> => {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, next: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  };
  const clampLimit = (n: number | undefined, d: number) => Math.min(Math.max(Math.trunc(n ?? d), 1), 100);

  /** Storage API（/storage/v1/object/…）：与 REST 同一个网关与 JWT，RLS 见 0010 */
  async function storage(
    path: string,
    init: { method: string; body?: Blob; headers?: Record<string, string> },
  ) {
    const token = await auth.accessToken().catch(() => null);
    if (!token) throw new NotSignedInError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(cfg.timeoutMs ?? 8000, 30_000));
    let res: Response;
    try {
      res = await f(`${cfg.url}/storage/v1/object/${path}`, {
        method: init.method,
        headers: { apikey: cfg.key, Authorization: `Bearer ${token}`, ...init.headers },
        // ArrayBuffer 而不是 Blob：各引擎都会带上准确的 Content-Length（个别 WebKit 版本对 Blob 请求体处理不一致）
        body: init.body ? await blobBytes(init.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DataUnavailableError((e as Error)?.message);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    throw storageError(res.status, body);
  }

  return {
    name: 'supabase',
    auth,
    media: {
      async uploadImage(blob, meta) {
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) =>
          b.toString(36).padStart(2, '0'),
        )
          .join('')
          .slice(0, 12);
        const path = objectPath(uid(), meta, rand);
        await storage(`${IMAGE_BUCKET}/${path}`, {
          method: 'POST',
          body: blob,
          headers: {
            'content-type': blob.type || 'application/octet-stream',
            'cache-control': '31536000',
            'x-upsert': 'false',
          },
        });
        return { path, url: publicImageUrl(path, cfg.url) };
      },
      async deleteImage(path) {
        if (!/^[0-9a-f-]{36}\/[a-z0-9][a-z0-9-]{0,79}\.(webp|png|jpe?g|gif)$/.test(path))
          throw new ValidationError('图片路径不正确');
        await storage(`${IMAGE_BUCKET}/${path}`, { method: 'DELETE' });
      },
    },
    // 后台原始通道：后台接口由 adminApiFor(repo)（admin-repo.ts）在后台页面里按需创建，公开页面的包不带它
    adminRest: {
      rest: <T>(path: string, init?: Parameters<typeof rest>[1]) => rest<T>(path, init).catch(notMigrated),
      restCount: (path, init) => restCount(path, init).catch(notMigrated),
    },
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
      async getThreadsByIds(ids) {
        const list = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200);
        if (!list.length) return [];
        const rows = await read(
          (c) => `forum_threads?select=${c}&id=in.(${list.join(',')})`,
          THREAD_COLS,
          LEGACY.thread,
        );
        return rows.map(toThread);
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
      async pageThreads(opts = {}) {
        const limit = clampLimit(opts.limit, 20);
        const f: string[] = ['published=eq.true'];
        if (opts.category) f.push(`cat=eq.${enc(categoryName(opts.category))}`);
        if (opts.author) f.push(`author=eq.${enc(opts.author)}`);
        if (opts.excludePinned) f.push('pinned=eq.false');
        const cur = decodeCursor(opts.cursor);
        if (cur)
          f.push(`or=(${enc(`created_at.lt.${q(cur.at)},and(created_at.eq.${q(cur.at)},id.lt.${cur.id})`)})`);
        const rows = await read(
          (c) => `forum_threads?select=${c}&${f.join('&')}&order=created_at.desc,id.desc&limit=${limit + 1}`,
          THREAD_COLS,
          LEGACY.thread,
        );
        return paged(rows.map(toThread), limit);
      },
      async pinnedThreads(opts = {}) {
        const cat = opts.category ? `&cat=eq.${enc(categoryName(opts.category))}` : '';
        const rows = await read(
          (c) =>
            `forum_threads?select=${c}&published=eq.true&pinned=eq.true${cat}&order=created_at.desc&limit=20`,
          THREAD_COLS,
          LEGACY.thread,
        );
        return rows.map(toThread);
      },
      async pageReplies(threadId, opts = {}) {
        const limit = clampLimit(opts.limit, 30);
        const f: string[] = [`thread_id=eq.${enc(threadId)}`];
        if (!opts.withHidden) f.push('published=eq.true');
        const cur = decodeCursor(opts.cursor);
        if (cur)
          f.push(`or=(${enc(`created_at.gt.${q(cur.at)},and(created_at.eq.${q(cur.at)},id.gt.${cur.id})`)})`);
        const rows = await read(
          (c) => `forum_replies?select=${c}&${f.join('&')}&order=created_at.asc,id.asc&limit=${limit + 1}`,
          REPLY_COLS,
          LEGACY.reply,
        );
        return paged(rows.map(toReply), limit);
      },
      async replyCountsFor(ids) {
        const keys = [...new Set(ids)].slice(0, 200);
        const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
        if (!keys.length) return out;
        try {
          const rows = await rest<{ thread_id: string; replies: number }[]>('rpc/thread_reply_counts', {
            method: 'POST',
            body: { p_keys: keys },
          });
          for (const r of rows ?? []) out[r.thread_id] = Number(r.replies) || 0;
        } catch (e) {
          if (!(e instanceof MissingObjectError)) throw e;
          // 旧库：取回复行自己数
          const list = keys.map((k) => q(k)).join(',');
          const rows = await rest<{ thread_id: string }[]>(
            `forum_replies?select=thread_id&published=eq.true&thread_id=in.(${enc(list)})&limit=5000`,
          );
          for (const r of rows) out[r.thread_id] = (out[r.thread_id] ?? 0) + 1;
        }
        return out;
      },
      async search(term, opts = {}) {
        const t = term.trim().slice(0, 100);
        if (!t) return [];
        const limit = clampLimit(opts.limit, 20);
        type Hit = Row & { author_name?: string | null; excerpt?: string };
        const toHit = (r: Hit): SearchHit => ({
          id: String(r.id),
          category: categoryId(String(r.cat ?? '')),
          title: String(r.title ?? ''),
          excerpt: String(r.excerpt ?? r.body ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 160),
          author: {
            id: (r.author as string) ?? null,
            name: r.author_name || r.profiles?.display_name || '匿名用户',
          },
          createdAt: String(r.created_at),
        });
        try {
          const rows = await rest<Hit[]>('rpc/search_threads', {
            method: 'POST',
            body: { q: t, p_limit: limit, p_offset: opts.offset ?? 0 },
          });
          return (rows ?? []).map(toHit);
        } catch (e) {
          if (!(e instanceof MissingObjectError)) throw e;
          // 旧库没有 RPC：退回 ILIKE（PostgREST 用 * 作通配符）
          const pat = q(`*${t.replace(/[*%_,()"\\]/g, ' ').trim()}*`);
          const rows = await rest<Hit[]>(
            `forum_threads?select=${LEGACY.thread}&published=eq.true&or=(${enc(`title.ilike.${pat},body.ilike.${pat}`)})&order=created_at.desc&limit=${limit}&offset=${opts.offset ?? 0}`,
          );
          return rows.map(toHit);
        }
      },
      async seedThread(key) {
        try {
          const rows = await rest(`forum_seed_threads?key=eq.${enc(key)}&select=key,locked`);
          return rows[0] ? { key: String(rows[0].key), locked: !!rows[0].locked } : { key, locked: false };
        } catch (e) {
          if (e instanceof MissingObjectError) return null;
          throw e;
        }
      },
      async setSeedLocked(key, locked) {
        const rows = await rest(`forum_seed_threads?key=eq.${enc(key)}&select=key,locked`, {
          method: 'PATCH',
          body: { locked },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, (r) => ({ key: String(r.key), locked: !!r.locked }));
      },
      async setReplyPublished(id, published) {
        const rows = await rest(`forum_replies?id=eq.${enc(id)}&select=${REPLY_COLS}`, {
          method: 'PATCH',
          body: { published },
          prefer: RET,
          requireAuth: true,
        });
        return one(rows, toReply);
      },
    },
    comments: {
      async list(pageKey, opts = {}) {
        const pub = opts.withHidden ? '' : '&published=eq.true';
        const rows = await read(
          (c) =>
            `comments?page_key=eq.${enc(pageKey)}${pub}&select=${c}&order=created_at.asc,id.asc&limit=500`,
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
      async setPublished(id, published) {
        const rows = await rest(`comments?id=eq.${enc(id)}&select=${COMMENT_COLS}`, {
          method: 'PATCH',
          body: { published },
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
    bookmarks: {
      async list() {
        const rows = await rest<{ thread_key: string; created_at: string }[]>(
          `bookmarks?user_id=eq.${enc(uid())}&select=thread_key,created_at&order=created_at.desc&limit=500`,
          { requireAuth: true },
        );
        return rows.map((r): Bookmark => ({ threadKey: r.thread_key, createdAt: r.created_at }));
      },
      async add(threadKey) {
        try {
          await rest('bookmarks', {
            method: 'POST',
            body: { user_id: uid(), thread_key: threadKey },
            prefer: 'return=minimal',
            requireAuth: true,
          });
        } catch (e) {
          if (!(e instanceof ValidationError && e.message === '已经提交过了')) throw e;
        }
      },
      async remove(threadKey) {
        await rest(`bookmarks?user_id=eq.${enc(uid())}&thread_key=eq.${enc(threadKey)}`, {
          method: 'DELETE',
          requireAuth: true,
        });
      },
      async has(keys) {
        const s = auth.getSession();
        if (!s || !keys.length) return new Set();
        const list = [...new Set(keys)]
          .slice(0, 200)
          .map((k) => q(k))
          .join(',');
        const rows = await rest<{ thread_key: string }[]>(
          `bookmarks?user_id=eq.${enc(s.user.id)}&thread_key=in.(${enc(list)})&select=thread_key`,
          { requireAuth: true },
        );
        return new Set(rows.map((r) => r.thread_key));
      },
    },
  };
}
