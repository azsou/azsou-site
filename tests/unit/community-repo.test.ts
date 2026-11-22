import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryRepository,
  createSupabaseRepository,
  ForbiddenError,
  memoryStore,
  NotSignedInError,
  RateLimitedError,
  ValidationError,
  type DataRepository,
  type Session,
} from '@/lib/data';
import { decodeCursor, encodeCursor, restError } from '@/lib/data/supabase';
import { friendlyError, intervalText, rateLimitMessage } from '@/lib/community-errors';
import { threadSitemapXml } from '@/lib/server/forum-sitemap';

type Call = { url: string; method: string; body: unknown };
function fakeFetch(routes: [RegExp, (c: Call) => { status?: number; json?: unknown }][]) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      url: decodeURIComponent(String(input)),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    const r = hit ? hit[1](c) : { status: 404, json: { message: 'no route' } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? null), { status });
  });
  return { f: f as unknown as typeof fetch, calls };
}
const session: Session = {
  accessToken: 'jwt',
  refreshToken: 'r',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u1', email: 'a@x.com', emailConfirmed: true, provider: 'email' },
};
const repoWith = (routes: Parameters<typeof fakeFetch>[0], signedIn = true) => {
  const { f, calls } = fakeFetch(routes);
  const store = memoryStore();
  if (signedIn) store.set(session);
  return { repo: createSupabaseRepository({ url: 'https://x.co', key: 'k', fetch: f, store }), calls };
};
const T = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  cat: '技术交流',
  title: `t-${id}`,
  body: 'b',
  author: 'u1',
  pinned: false,
  published: true,
  created_at: at,
  profiles: { display_name: 'A' },
  ...extra,
});

describe('supabase adapter · P3', () => {
  it('pageThreads：多取一行判断下一页，游标为 created_at|id，下一页用 keyset 过滤', async () => {
    const rows = [
      T('a', '2026-10-03T00:00:00Z'),
      T('b', '2026-10-02T00:00:00Z'),
      T('c', '2026-10-01T00:00:00Z'),
    ];
    const { repo, calls } = repoWith([[/forum_threads/, () => ({ json: rows })]]);
    const p1 = await repo.forum.pageThreads({ category: 'tech', limit: 2, excludePinned: true });
    expect(p1.items.map((t) => t.id)).toEqual(['a', 'b']);
    expect(p1.next).toBe('2026-10-02T00:00:00Z|b');
    expect(calls[0].url).toContain('cat=eq.技术交流');
    expect(calls[0].url).toContain('pinned=eq.false');
    expect(calls[0].url).toContain('order=created_at.desc,id.desc&limit=3');
    await repo.forum.pageThreads({ limit: 2, cursor: p1.next, author: 'u9' });
    expect(calls[1].url).toContain(
      'or=(created_at.lt."2026-10-02T00:00:00Z",and(created_at.eq."2026-10-02T00:00:00Z",id.lt.b))',
    );
    expect(calls[1].url).toContain('author=eq.u9');
  });

  it('pageReplies：正序 keyset；withHidden 时不加 published 过滤（交给 RLS）', async () => {
    const { repo, calls } = repoWith([[/forum_replies/, () => ({ json: [] })]]);
    await repo.forum.pageReplies('t-announce', { cursor: '2026-10-01T00:00:00Z|r1' });
    expect(calls[0].url).toContain('published=eq.true');
    expect(calls[0].url).toContain('created_at.gt."2026-10-01T00:00:00Z"');
    expect(calls[0].url).toContain('order=created_at.asc,id.asc');
    await repo.forum.pageReplies('t-announce', { withHidden: true });
    expect(calls[1].url).not.toContain('published=eq.true');
  });

  it('replyCountsFor：调用 RPC；旧库（PGRST202）退回数回复行', async () => {
    const ok = repoWith([[/rpc\/thread_reply_counts/, () => ({ json: [{ thread_id: 't-a', replies: 3 }] })]]);
    expect(await ok.repo.forum.replyCountsFor(['t-a', 't-b'])).toEqual({ 't-a': 3, 't-b': 0 });
    expect(ok.calls[0].body).toEqual({ p_keys: ['t-a', 't-b'] });
    const old = repoWith([
      [/rpc\/thread_reply_counts/, () => ({ status: 404, json: { code: 'PGRST202' } })],
      [/forum_replies\?select=thread_id/, () => ({ json: [{ thread_id: 't-a' }, { thread_id: 't-a' }] })],
    ]);
    expect(await old.repo.forum.replyCountsFor(['t-a'])).toEqual({ 't-a': 2 });
    expect(old.calls[1].url).toContain('thread_id=in.("t-a")');
  });

  it('search：RPC search_threads；旧库退回 ILIKE 并清理通配符', async () => {
    const ok = repoWith([
      [
        /rpc\/search_threads/,
        () => ({
          json: [
            {
              id: 'x',
              cat: '产品讨论',
              title: '标题',
              excerpt: '摘要',
              author: 'u',
              author_name: '作者',
              created_at: 'z',
            },
          ],
        }),
      ],
    ]);
    const hits = await ok.repo.forum.search('  拼音  ');
    expect(ok.calls[0].body).toEqual({ q: '拼音', p_limit: 20, p_offset: 0 });
    expect(hits[0]).toMatchObject({
      id: 'x',
      category: 'product',
      author: { name: '作者' },
      excerpt: '摘要',
    });
    expect(await ok.repo.forum.search('   ')).toEqual([]);
    const old = repoWith([
      [/rpc\/search_threads/, () => ({ status: 404, json: { code: 'PGRST202' } })],
      [/forum_threads/, () => ({ json: [T('y', 'z')] })],
    ]);
    const h2 = await old.repo.forum.search('a*b,(c)');
    expect(old.calls[1].url).toContain('or=(title.ilike."*a b  c*",body.ilike."*a b  c*")');
    expect(h2[0].id).toBe('y');
  });

  it('seedThread：表不存在（PGRST205，旧库）返回 null；setSeedLocked / setReplyPublished / comments.setPublished 发 PATCH', async () => {
    const old = repoWith([[/forum_seed_threads/, () => ({ status: 404, json: { code: 'PGRST205' } })]]);
    expect(await old.repo.forum.seedThread('t-a')).toBeNull();
    const { repo, calls } = repoWith([
      [/PATCH .*forum_seed_threads/, () => ({ json: [{ key: 't-a', locked: true }] })],
      [
        /PATCH .*forum_replies/,
        (c) => ({
          json: [{ id: 'r', thread_id: 't', body: 'b', author: 'u', created_at: 'z', ...(c.body as object) }],
        }),
      ],
      [
        /PATCH .*comments/,
        (c) => ({
          json: [
            {
              id: 'c',
              page_key: 'article:x',
              body: 'b',
              author: 'u',
              created_at: 'z',
              ...(c.body as object),
            },
          ],
        }),
      ],
    ]);
    expect(await repo.forum.setSeedLocked('t-a', true)).toEqual({ key: 't-a', locked: true });
    expect((await repo.forum.setReplyPublished('r', false)).published).toBe(false);
    expect((await repo.comments.setPublished('c', false)).published).toBe(false);
    expect(calls.map((c) => c.body)).toEqual([{ locked: true }, { published: false }, { published: false }]);
  });

  it('bookmarks：list / add（重复忽略）/ remove / has', async () => {
    const { repo, calls } = repoWith([
      [
        /GET .*bookmarks\?user_id=eq.u1&select=thread_key,created_at/,
        () => ({ json: [{ thread_key: 't-a', created_at: 'z' }] }),
      ],
      [/POST .*bookmarks/, () => ({ status: 409, json: { code: '23505' } })],
      [/DELETE .*bookmarks/, () => ({ status: 204 })],
      [/GET .*bookmarks\?user_id=eq.u1&thread_key=in/, () => ({ json: [{ thread_key: 't-a' }] })],
    ]);
    expect(await repo.bookmarks.list()).toEqual([{ threadKey: 't-a', createdAt: 'z' }]);
    await expect(repo.bookmarks.add('t-a')).resolves.toBeUndefined();
    expect(calls[1].body).toEqual({ user_id: 'u1', thread_key: 't-a' });
    await repo.bookmarks.remove('t-a');
    expect(calls[2].url).toContain('bookmarks?user_id=eq.u1&thread_key=eq.t-a');
    expect([...(await repo.bookmarks.has(['t-a', 't-b']))]).toEqual(['t-a']);
  });

  it('未登录：bookmarks.has 返回空集合，写操作抛 NotSignedInError', async () => {
    const { repo } = repoWith([], false);
    expect((await repo.bookmarks.has(['t-a'])).size).toBe(0);
    await expect(repo.bookmarks.add('t-a')).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('getThreadsByIds：只接受 uuid，一次 in.() 查询', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const { repo, calls } = repoWith([[/forum_threads/, () => ({ json: [T(id, 'z')] })]]);
    expect((await repo.forum.getThreadsByIds([id, 't-x', 'bad'])).map((t) => t.id)).toEqual([id]);
    expect(calls[0].url).toContain(`id=in.(${id})`);
    expect(await repo.forum.getThreadsByIds(['t-x'])).toEqual([]);
  });

  it('限流错误保留数据库 detail', () => {
    const e = restError(429, {
      code: 'PT429',
      hint: '操作太频繁，请稍后再试。',
      details: 'reply: 最多 6 次 / 00:01:00',
    });
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as RateLimitedError).detail).toBe('reply: 最多 6 次 / 00:01:00');
  });

  it('游标编码 / 解码，拒绝畸形游标', () => {
    expect(decodeCursor(encodeCursor('2026-10-01T00:00:00.123+00:00', 'abc-1'))).toEqual({
      at: '2026-10-01T00:00:00.123+00:00',
      id: 'abc-1',
    });
    expect(decodeCursor('nope')).toBeNull();
    expect(decodeCursor('2026-10-01|a,b)')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

// ------------------------------------------------------------------ memory
const users = [
  { id: 'u-alice', email: 'alice@example.com', password: 'alicepass1', displayName: 'alice' },
  { id: 'u-bob', email: 'bob@example.com', password: 'bobpass12', displayName: 'bob' },
  {
    id: 'u-mia',
    email: 'mia@example.com',
    password: 'miapass12',
    displayName: 'mia',
    role: 'moderator' as const,
  },
];
const fresh = () => createMemoryRepository({ users, seedThreads: { 't-announce': false } });
const login = (r: DataRepository, who: string) => {
  const u = users.find((x) => x.displayName === who)!;
  return r.auth.signIn(u.email, u.password);
};

describe('memory adapter · P3（与数据库语义一致的契约基准）', () => {
  it('pageThreads / pinnedThreads / 作者过滤 / 游标无重复', async () => {
    let t = 0;
    const repo = createMemoryRepository({
      users,
      now: () => new Date(Date.UTC(2026, 9, 1, 0, t++)).toISOString(),
    });
    await login(repo, 'alice');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await repo.forum.createThread({ category: 'tech', title: `T${i}`, body: 'b' })).id);
    await login(repo, 'mia');
    await repo.forum.setThreadFlags(ids[0], { pinned: true });
    expect((await repo.forum.pinnedThreads({ category: 'tech' })).map((x) => x.id)).toEqual([ids[0]]);
    const p1 = await repo.forum.pageThreads({ category: 'tech', limit: 2, excludePinned: true });
    const p2 = await repo.forum.pageThreads({
      category: 'tech',
      limit: 2,
      excludePinned: true,
      cursor: p1.next,
    });
    expect([...p1.items, ...p2.items].map((x) => x.title)).toEqual(['T4', 'T3', 'T2', 'T1']);
    expect(p2.next).toBeNull();
    expect((await repo.forum.pageThreads({ author: 'u-mia' })).items).toEqual([]);
  });

  it('回复分页、计数、隐藏（版主）与 withHidden 可见性', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const th = await repo.forum.createThread({ category: 'tech', title: 'x', body: 'y' });
    const r1 = await repo.forum.reply(th.id, 'one');
    await repo.forum.reply('t-announce', 'seed');
    expect(await repo.forum.replyCountsFor([th.id, 't-announce', 't-none'])).toEqual({
      [th.id]: 1,
      't-announce': 1,
      't-none': 0,
    });
    await expect(repo.forum.setReplyPublished(r1.id, false)).rejects.toBeInstanceOf(ForbiddenError);
    await login(repo, 'mia');
    await repo.forum.setReplyPublished(r1.id, false);
    expect((await repo.forum.pageReplies(th.id)).items).toEqual([]);
    expect((await repo.forum.pageReplies(th.id, { withHidden: true })).items).toHaveLength(1);
    await login(repo, 'bob');
    expect((await repo.forum.pageReplies(th.id, { withHidden: true })).items).toEqual([]);
    await login(repo, 'alice');
    expect((await repo.forum.pageReplies(th.id, { withHidden: true })).items).toHaveLength(1);
  });

  it('种子主题锁定：仅版主', async () => {
    const repo = fresh();
    expect(await repo.forum.seedThread('t-announce')).toEqual({ key: 't-announce', locked: false });
    expect(await repo.forum.seedThread('t-nope')).toBeNull();
    await login(repo, 'alice');
    await expect(repo.forum.setSeedLocked('t-announce', true)).rejects.toBeInstanceOf(ForbiddenError);
    await login(repo, 'mia');
    await repo.forum.setSeedLocked('t-announce', true);
    await login(repo, 'alice');
    await expect(repo.forum.reply('t-announce', 'x')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('搜索：标题命中优先，大小写不敏感，隐藏帖不出现', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const a = await repo.forum.createThread({ category: 'tech', title: '正文里有', body: 'Pinyin 搜索' });
    const b = await repo.forum.createThread({ category: 'tech', title: 'pinyin 标题', body: 'x' });
    const c = await repo.forum.createThread({ category: 'tech', title: 'PINYIN 隐藏', body: 'x' });
    await login(repo, 'mia');
    await repo.forum.setThreadFlags(c.id, { published: false });
    expect((await repo.forum.search('pinyin')).map((h) => h.id)).toEqual([b.id, a.id]);
    expect(await repo.forum.search(' ')).toEqual([]);
  });

  it('收藏：增删查、重复添加幂等、非法 key 拒绝、未登录拒绝', async () => {
    const repo = fresh();
    await expect(repo.bookmarks.list()).rejects.toBeInstanceOf(NotSignedInError);
    await login(repo, 'alice');
    await repo.bookmarks.add('t-announce');
    await repo.bookmarks.add('t-announce');
    expect((await repo.bookmarks.list()).map((b) => b.threadKey)).toEqual(['t-announce']);
    expect([...(await repo.bookmarks.has(['t-announce', 't-x']))]).toEqual(['t-announce']);
    await expect(repo.bookmarks.add('bad key')).rejects.toBeInstanceOf(ValidationError);
    await repo.bookmarks.remove('t-announce');
    expect(await repo.bookmarks.list()).toEqual([]);
    await login(repo, 'bob');
    expect((await repo.bookmarks.has(['t-announce'])).size).toBe(0);
  });

  it('评论隐藏与 withHidden', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const c = await repo.comments.create('article:x', 'hi');
    await login(repo, 'mia');
    await repo.comments.setPublished(c.id, false);
    await login(repo, 'bob');
    expect(await repo.comments.list('article:x', { withHidden: true })).toEqual([]);
    await login(repo, 'alice');
    expect(await repo.comments.list('article:x', { withHidden: true })).toHaveLength(1);
    expect(await repo.comments.list('article:x')).toEqual([]);
  });

  it('getThreadsByIds 只返回可见主题', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const a = await repo.forum.createThread({ category: 'tech', title: 'a', body: 'b' });
    expect((await repo.forum.getThreadsByIds([a.id, 'x'])).map((t) => t.id)).toEqual([a.id]);
  });
});

describe('中文错误提示', () => {
  it('interval 文本', () => {
    expect(intervalText('00:10:00')).toBe('10 分钟');
    expect(intervalText('00:01:00')).toBe('1 分钟');
    expect(intervalText('01:00:00')).toBe('1 小时');
    expect(intervalText('1 day')).toBe('1 天');
    expect(intervalText('00:00:30')).toBe('30 秒');
    expect(intervalText('01:30:00')).toBe('90 分钟');
  });
  it('限流 detail → 说明每多久最多几次', () => {
    expect(rateLimitMessage('thread: 最多 3 次 / 00:10:00')).toBe(
      '发主题太频繁了：为防止刷屏，每 10 分钟最多发主题 3 次。请稍后再试。',
    );
    expect(rateLimitMessage('comment_hour: 最多 60 次 / 01:00:00')).toContain('每 1 小时最多评论 60 次');
    expect(rateLimitMessage('')).toBe('操作太频繁了，请稍等一会儿再试。');
  });
  it('friendlyError 覆盖各类仓储错误', () => {
    expect(friendlyError(new RateLimitedError('x', 'reply: 最多 6 次 / 00:01:00'))).toContain('回复太频繁');
    expect(friendlyError(new ForbiddenError('主题已锁定或不可回复'))).toBe(
      '这个主题已锁定，不能再回复或编辑。',
    );
    expect(friendlyError(new ForbiddenError('账号已被限制发言'))).toBe('你的账号已被限制发言。');
    expect(friendlyError(new ValidationError('已经提交过了'))).toBe('你已经提交过了，无需重复操作。');
    expect(friendlyError(new NotSignedInError())).toBe('请先登录。');
    expect(friendlyError(new Error('boom'))).toBe('操作失败，请稍后再试。');
  });
});

describe('论坛主题 sitemap', () => {
  it('列出 /forum/t/?id=…，跳过非 uuid，lastmod 用编辑时间', () => {
    const xml = threadSitemapXml('https://azsou.com/', [
      {
        id: '11111111-2222-4333-8444-555555555555',
        created_at: '2026-10-01T00:00:00Z',
        edited_at: '2026-10-02T00:00:00Z',
      },
      { id: '<bad>', created_at: 'x' },
    ]);
    expect(xml).toContain('<loc>https://azsou.com/forum/t/?id=11111111-2222-4333-8444-555555555555</loc>');
    expect(xml).toContain('<lastmod>2026-10-02T00:00:00.000Z</lastmod>');
    expect(xml).not.toContain('bad');
    expect(xml.startsWith('<?xml')).toBe(true);
  });
});
