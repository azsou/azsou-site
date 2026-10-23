import { categoryId, DataUnavailableError, type Author, type DataRepository, type Thread } from './types';

/**
 * Supabase 适配器（只读，P1）。直接调 PostgREST，不引 supabase-js（首屏 JS 预算）。
 * 只用标准 REST 查询；表结构与 V72 一致：forum_threads / forum_replies / comments / profiles。
 */
export interface SupabaseConfig {
  url: string;
  key: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
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
  createdAt: String(r.created_at),
});

const THREAD_COLS = 'id,cat,title,body,author,pinned,published,created_at,profiles(display_name)';

export function createSupabaseRepository(cfg: SupabaseConfig): DataRepository {
  const f = cfg.fetch ?? fetch;
  async function rest<T = Row[]>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8000);
    try {
      const res = await f(`${cfg.url}/rest/v1/${path}`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new DataUnavailableError(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof DataUnavailableError) throw e;
      throw new DataUnavailableError((e as Error)?.message);
    } finally {
      clearTimeout(timer);
    }
  }
  const enc = encodeURIComponent;
  return {
    name: 'supabase',
    forum: {
      async listThreads(opts = {}) {
        const rows = await rest(
          `forum_threads?select=${THREAD_COLS}&published=eq.true&order=created_at.desc&limit=${opts.limit ?? 200}`,
        );
        return rows.map(toThread).filter((t) => !opts.category || t.category === opts.category);
      },
      async getThread(id) {
        const rows = await rest(
          `forum_threads?select=${THREAD_COLS}&id=eq.${enc(id)}&published=eq.true&limit=1`,
        );
        return rows[0] ? toThread(rows[0]) : null;
      },
      async listReplies(threadId) {
        const rows = await rest(
          `forum_replies?thread_id=eq.${enc(threadId)}&published=eq.true&select=id,thread_id,body,author,created_at,profiles(display_name)&order=created_at.asc`,
        );
        return rows.map((r) => ({
          id: String(r.id),
          threadId: String(r.thread_id),
          body: String(r.body ?? ''),
          author: author(r),
          createdAt: String(r.created_at),
        }));
      },
      async replyCounts() {
        const rows = await rest<{ thread_id: string }[]>(
          'forum_replies?select=thread_id&published=eq.true&limit=5000',
        );
        const m: Record<string, number> = {};
        for (const r of rows) if (r.thread_id) m[r.thread_id] = (m[r.thread_id] ?? 0) + 1;
        return m;
      },
    },
    comments: {
      async list(pageKey) {
        const rows = await rest(
          `comments?page_key=eq.${enc(pageKey)}&published=eq.true&select=id,page_key,body,author,created_at,profiles(display_name)&order=created_at.asc`,
        );
        return rows.map((r) => ({
          id: String(r.id),
          pageKey: String(r.page_key),
          body: String(r.body ?? ''),
          author: author(r),
          createdAt: String(r.created_at),
        }));
      },
    },
  };
}
