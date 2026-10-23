import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryRepository,
  createSupabaseRepository,
  DataUnavailableError,
  categoryId,
  type DataRepository,
} from '@/lib/data';

const threads = [
  { id: 'a', category: 'tech', title: 'A', body: 'x', author: { id: '1', name: 'u1' }, pinned: false, createdAt: '2026-07-20T00:00:00Z' },
  { id: 'b', category: 'product', title: 'B', body: 'y', author: { id: '2', name: 'u2' }, pinned: false, createdAt: '2026-07-27T00:00:00Z' },
];
const replies = [
  { id: 'r2', threadId: 'b', body: 'later', author: { id: '1', name: 'u1' }, createdAt: '2026-07-28T00:00:00Z' },
  { id: 'r1', threadId: 'b', body: 'first', author: { id: '1', name: 'u1' }, createdAt: '2026-07-27T01:00:00Z' },
];
const comments = [{ id: 'c1', pageKey: 'article:x', body: 'hi', author: { id: '1', name: 'u1' }, createdAt: '2026-07-27T00:00:00Z' }];

/** 契约测试：任何适配器（Supabase、内存、将来的 Neon/自建 PG）都应满足同样的行为 */
async function contract(repo: DataRepository) {
  const all = await repo.forum.listThreads();
  expect(all.map((t) => t.id)).toEqual(['b', 'a']); // 新的在前
  expect((await repo.forum.listThreads({ category: 'tech' })).map((t) => t.id)).toEqual(['a']);
  expect((await repo.forum.getThread('b'))?.title).toBe('B');
  expect(await repo.forum.getThread('nope')).toBeNull();
  expect((await repo.forum.listReplies('b')).map((r) => r.id)).toEqual(['r1', 'r2']); // 旧的在前
  expect(await repo.forum.replyCounts()).toEqual({ b: 2 });
  expect((await repo.comments.list('article:x')).map((c) => c.body)).toEqual(['hi']);
}

describe('memory adapter', () => {
  it('satisfies the repository contract', async () => {
    await contract(createMemoryRepository({ threads, replies, comments }));
  });
});

describe('supabase adapter', () => {
  const rowsFor = (path: string): unknown[] => {
    const prof = { profiles: { display_name: 'u1' } };
    if (path.startsWith('forum_threads')) {
      const list = [
        { id: 'b', cat: '产品讨论', title: 'B', body: 'y', author: '2', pinned: false, created_at: '2026-07-27T00:00:00Z', ...prof },
        { id: 'a', cat: '技术交流', title: 'A', body: 'x', author: '1', pinned: false, created_at: '2026-07-20T00:00:00Z', ...prof },
      ];
      const id = /id=eq\.([^&]+)/.exec(path)?.[1];
      return id ? list.filter((t) => t.id === id) : list;
    }
    if (path.startsWith('forum_replies?select=thread_id')) return [{ thread_id: 'b' }, { thread_id: 'b' }];
    if (path.startsWith('forum_replies')) {
      return /thread_id=eq\.b/.test(path)
        ? [
            { id: 'r1', thread_id: 'b', body: 'first', author: '1', created_at: '2026-07-27T01:00:00Z', ...prof },
            { id: 'r2', thread_id: 'b', body: 'later', author: '1', created_at: '2026-07-28T00:00:00Z', ...prof },
          ]
        : [];
    }
    if (path.startsWith('comments'))
      return [{ id: 'c1', page_key: 'article:x', body: 'hi', author: '1', created_at: '2026-07-27T00:00:00Z', ...prof }];
    return [];
  };
  const fakeFetch = vi.fn(async (input: string | URL | Request) => {
    const path = String(input).split('/rest/v1/')[1];
    return new Response(JSON.stringify(rowsFor(path)), { status: 200 });
  }) as unknown as typeof fetch;

  it('satisfies the repository contract against PostgREST-shaped rows', async () => {
    await contract(createSupabaseRepository({ url: 'https://example.supabase.co', key: 'k', fetch: fakeFetch }));
  });

  it('sends the publishable key and only requests published rows', async () => {
    const f = vi.fn(async () => new Response('[]')) as unknown as typeof fetch;
    await createSupabaseRepository({ url: 'https://e.co', key: 'pk', fetch: f }).comments.list('article:a b');
    const [u, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(u).toContain('page_key=eq.article%3Aa%20b');
    expect(u).toContain('published=eq.true');
    expect((init.headers as Record<string, string>).apikey).toBe('pk');
  });

  it('throws DataUnavailableError on HTTP errors and network failures', async () => {
    const bad = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
    await expect(createSupabaseRepository({ url: 'https://e.co', key: 'k', fetch: bad }).forum.listThreads()).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(createSupabaseRepository({ url: 'https://e.co', key: 'k', fetch: down }).comments.list('x')).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
  });

  it('maps legacy Chinese category names to ids', () => {
    expect(categoryId('公告')).toBe('announce');
    expect(categoryId('tech')).toBe('tech');
    expect(categoryId('奇怪')).toBe('meta');
  });
});
