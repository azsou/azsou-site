/**
 * 应用商店（P6，迁移 0012）的数据接口：评价、评分统计、下载计数。
 * 直接调 PostgREST（与 supabase.ts 同一套网关与 JWT），不引 supabase-js。
 * 权限全部在数据库：评价的 RLS / 一人一条 / 限流，下载计数的去重 / 限流 / 爬虫过滤（app_count_download）。
 */
import { mergeStats, type AppStats, type PlatformOs } from '../app-store';
import { restError } from './supabase';
import { DataUnavailableError, NotSignedInError, ValidationError, type Author } from './types';
import { supabaseConfig } from '../supabase-config';
import { getRepository } from './index';

export interface Review {
  id: string;
  app: string;
  author: Author;
  rating: number;
  title: string;
  body: string;
  version: string;
  published: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface ReviewStats {
  reviews: number;
  average: number | null;
  /** 下标 0 = 1 星 … 4 = 5 星 */
  distribution: [number, number, number, number, number];
}

export interface ReviewInput {
  rating: number;
  title?: string;
  body?: string;
  version?: string;
}

export const REVIEW_LIMITS = { title: 60, body: 1000, version: 40 } as const;

export interface AppStoreApi {
  /** 多个应用的下载总数与评分（目录排序用）；数据库不可达时抛 DataUnavailableError */
  stats(slugs?: string[]): Promise<Record<string, AppStats>>;
  /** 单个应用：每个平台的下载次数 + 评分统计 */
  appStats(slug: string): Promise<{ downloads: Partial<Record<PlatformOs, number>>; reviews: ReviewStats }>;
  /** 记一次下载（数据库负责去重 / 限流 / 爬虫过滤），返回该平台当前累计次数 */
  countDownload(slug: string, platform: PlatformOs): Promise<number>;
  listReviews(
    slug: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<{ items: Review[]; more: boolean }>;
  /** 当前用户对这个应用的评价（含被隐藏的）；未登录为 null */
  myReview(slug: string, uid: string): Promise<Review | null>;
  createReview(slug: string, input: ReviewInput): Promise<Review>;
  updateReview(id: string, input: ReviewInput): Promise<Review>;
  /** 版主：隐藏 / 恢复 */
  setPublished(id: string, published: boolean): Promise<Review>;
  deleteReview(id: string): Promise<void>;
}

export interface AppStoreConfig {
  url: string;
  key: string;
  /** 当前用户的 access token（未登录为 null） */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Row = Record<string, unknown> & { profiles?: { display_name?: string | null } | null };
const COLS = 'id,app,author,rating,title,body,version,published,created_at,edited_at,profiles(display_name)';
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toReview = (r: Row): Review => ({
  id: String(r.id),
  app: String(r.app),
  author: { id: (r.author as string) ?? null, name: r.profiles?.display_name || '匿名用户' },
  rating: Number(r.rating),
  title: String(r.title ?? ''),
  body: String(r.body ?? ''),
  version: String(r.version ?? ''),
  published: r.published !== false,
  createdAt: String(r.created_at),
  editedAt: (r.edited_at as string) ?? null,
});

/** 与数据库约束一致的前端校验；返回中文错误或 null */
export function checkReview(input: ReviewInput): string | null {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) return '请选择 1–5 星';
  if ([...(input.title ?? '').trim()].length > REVIEW_LIMITS.title)
    return `标题最多 ${REVIEW_LIMITS.title} 个字`;
  if ([...(input.body ?? '').trim()].length > REVIEW_LIMITS.body)
    return `评价最多 ${REVIEW_LIMITS.body} 个字`;
  if ([...(input.version ?? '').trim()].length > REVIEW_LIMITS.version) return '版本号太长';
  return null;
}

export function createAppStoreApi(cfg: AppStoreConfig): AppStoreApi {
  const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const enc = encodeURIComponent;

  async function rest<T = Row[]>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      prefer?: string;
      auth?: 'required' | 'optional';
      keepalive?: boolean;
    } = {},
  ): Promise<T> {
    const token = await cfg.token().catch(() => null);
    if (init.auth === 'required' && !token) throw new NotSignedInError();
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
        keepalive: init.keepalive,
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
      const code = (json as { code?: string } | null)?.code;
      // 生产库还没执行 0012：表 / 视图 / RPC 不存在
      if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883')
        throw new DataUnavailableError('数据库还没有执行应用商店迁移（0012）');
      throw restError(res.status, json as Record<string, unknown>);
    }
    return json as T;
  }

  const slugOk = (s: string) => {
    if (!SLUG.test(s)) throw new ValidationError('应用标识不正确');
    return s;
  };
  const idOk = (s: string) => {
    if (!UUID.test(s)) throw new ValidationError('评价不存在');
    return s;
  };
  const clean = (i: ReviewInput) => {
    const err = checkReview(i);
    if (err) throw new ValidationError(err);
    return {
      rating: i.rating,
      title: (i.title ?? '').trim(),
      body: (i.body ?? '').trim(),
      version: (i.version ?? '').trim(),
    };
  };
  const one = (rows: Row[] | null) => {
    if (!rows?.length) throw new ValidationError('没有权限，或评价已被删除');
    return toReview(rows[0]);
  };

  return {
    async stats(slugs) {
      const filter = slugs?.length ? `&app=in.(${slugs.filter((s) => SLUG.test(s)).join(',')})` : '';
      const [d, r] = await Promise.all([
        rest<{ app: string; downloads: number }[]>(`app_download_counts?select=app,downloads${filter}`),
        rest<{ app: string; reviews: number; average: number | null }[]>(
          `app_review_stats?select=app,reviews,average${filter}`,
        ),
      ]);
      return mergeStats(d ?? [], r ?? []);
    },
    async appStats(slug) {
      slugOk(slug);
      const [d, r] = await Promise.all([
        rest<{ platform: PlatformOs; downloads: number }[]>(
          `app_download_counts?select=platform,downloads&app=eq.${enc(slug)}`,
        ),
        rest<Record<string, number | string | null>[]>(
          `app_review_stats?select=reviews,average,r1,r2,r3,r4,r5&app=eq.${enc(slug)}`,
        ),
      ]);
      const downloads: Partial<Record<PlatformOs, number>> = {};
      for (const x of d ?? []) downloads[x.platform] = Number(x.downloads) || 0;
      const s = r?.[0];
      return {
        downloads,
        reviews: s
          ? {
              reviews: Number(s.reviews) || 0,
              average: s.average === null ? null : Number(s.average),
              distribution: [1, 2, 3, 4, 5].map(
                (k) => Number(s[`r${k}`]) || 0,
              ) as ReviewStats['distribution'],
            }
          : { reviews: 0, average: null, distribution: [0, 0, 0, 0, 0] },
      };
    },
    async countDownload(slug, platform) {
      slugOk(slug);
      const n = await rest<number>('rpc/app_count_download', {
        method: 'POST',
        body: { p_app: slug, p_platform: platform },
        keepalive: true,
      });
      return Number(n) || 0;
    },
    async listReviews(slug, opts = {}) {
      slugOk(slug);
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 50);
      const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
      const rows = await rest(
        `app_reviews?select=${COLS}&app=eq.${enc(slug)}&published=eq.true&order=created_at.desc,id.desc&limit=${limit + 1}&offset=${offset}`,
      );
      return { items: (rows ?? []).slice(0, limit).map(toReview), more: (rows ?? []).length > limit };
    },
    async myReview(slug, uid) {
      slugOk(slug);
      if (!UUID.test(uid)) return null;
      const rows = await rest(`app_reviews?select=${COLS}&app=eq.${enc(slug)}&author=eq.${uid}&limit=1`, {
        auth: 'required',
      });
      return rows?.[0] ? toReview(rows[0]) : null;
    },
    async createReview(slug, input) {
      slugOk(slug);
      const rows = await rest(`app_reviews?select=${COLS}`, {
        method: 'POST',
        body: { app: slug, ...clean(input) },
        prefer: 'return=representation',
        auth: 'required',
      });
      return one(rows);
    },
    async updateReview(id, input) {
      const rows = await rest(`app_reviews?id=eq.${idOk(id)}&select=${COLS}`, {
        method: 'PATCH',
        body: clean(input),
        prefer: 'return=representation',
        auth: 'required',
      });
      return one(rows);
    },
    async setPublished(id, published) {
      const rows = await rest(`app_reviews?id=eq.${idOk(id)}&select=${COLS}`, {
        method: 'PATCH',
        body: { published },
        prefer: 'return=representation',
        auth: 'required',
      });
      return one(rows);
    },
    async deleteReview(id) {
      const rows = await rest(`app_reviews?id=eq.${idOk(id)}&select=id`, {
        method: 'DELETE',
        prefer: 'return=representation',
        auth: 'required',
      });
      if (!rows?.length) throw new ValidationError('没有权限，或评价已被删除');
    },
  };
}

let appStore: AppStoreApi | null = null;
/**
 * 浏览器端入口：与仓储共用同一个登录会话。
 * 单独放在这个模块（不从 @/lib/data 导出），论坛等页面的首屏包里不会带上应用商店的代码。
 */
export function getAppStore(): AppStoreApi {
  if (appStore) return appStore;
  const repo = getRepository();
  appStore = createAppStoreApi({
    ...supabaseConfig(),
    token: () => repo.auth.accessToken(),
  });
  return appStore;
}
