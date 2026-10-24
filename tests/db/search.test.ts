/**
 * 0008：论坛搜索 RPC（pg_trgm）与回复计数 RPC —— 权限、RLS、转义、索引。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './helpers';
import { R, T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('search');
  await db.pool.query(
    `insert into public.forum_threads (cat, title, body, author) values
      ('技术交流', '拼音首字母搜索的实现', '我们用 pg_trgm 做中文搜索，命中率 100%_ok', $1),
      ('产品讨论', '时间轴关键帧', '关于拼音输入法的一点补充', $1)`,
    [U.alice],
  );
});
afterAll(async () => {
  await db?.close();
});

const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const search = (q: string, lim = 20, off = 0) =>
  run(db.pool, anon, `select id, title, excerpt, author_name, score from public.search_threads($1, $2, $3)`, [
    q,
    lim,
    off,
  ]);

describe('0008 search_threads', () => {
  it('匿名可调用；中文子串命中标题与正文，标题命中排前，带作者昵称与摘要', async () => {
    const r = await search('拼音');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.title)).toEqual(['拼音首字母搜索的实现', '时间轴关键帧']);
    expect(r.rows[0].author_name).toBe('alice');
    expect(String(r.rows[1].excerpt)).toContain('拼音输入法');
  });
  it('% 与 _ 按字面匹配（ILIKE 转义），不是通配符', async () => {
    const pct = await search('%');
    const under = await search('_');
    const both = await search('100%_');
    for (const r of [pct, under, both])
      expect(r.ok && r.rows.map((x) => x.title)).toEqual(['拼音首字母搜索的实现']);
  });
  it('空串 / 超长查询返回空；limit 上限 50、offset 生效', async () => {
    const blank = await search('   ');
    const long = await search('x'.repeat(101));
    expect(blank.ok && blank.rowCount).toBe(0);
    expect(long.ok && long.rowCount).toBe(0);
    const all = await search('thread', 1000);
    expect(all.ok && all.rowCount).toBeLessThanOrEqual(50);
    const first = await search('thread', 1, 0);
    const second = await search('thread', 1, 1);
    expect(first.ok && second.ok && first.rows[0].id !== second.rows[0].id).toBe(true);
  });
  it('隐藏主题不出现在搜索里——即使是作者本人或版主', async () => {
    for (const who of [anon, as(U.bob), as(U.mia)]) {
      const r = await run(db.pool, who, `select id from public.search_threads('hidden')`);
      expect(r.ok && r.rows.map((x) => x.id)).not.toContain(T.bobHidden);
    }
  });
  it('是 SECURITY INVOKER（受 RLS 约束），固定了 search_path', async () => {
    const r = await db.pool.query(
      `select prosecdef, proconfig from pg_proc where proname in ('search_threads', 'thread_reply_counts') order by proname`,
    );
    for (const row of r.rows) {
      expect(row.prosecdef).toBe(false);
      expect(row.proconfig.some((c: string) => c.startsWith('search_path='))).toBe(true);
    }
  });
  it('标题 / 正文有三元组 GIN 索引，ILIKE 可走索引', async () => {
    const r = await db.pool.query(
      `select indexname from pg_indexes where tablename = 'forum_threads' and indexdef ilike '%gin_trgm_ops%' order by 1`,
    );
    expect(r.rows.map((x) => x.indexname)).toEqual([
      'forum_threads_body_trgm_idx',
      'forum_threads_title_trgm_idx',
    ]);
    const c = await db.pool.connect();
    try {
      await c.query('set enable_seqscan = off');
      const plan = await c.query(`explain select id from forum_threads where title ilike '%拼音首字%'`);
      expect(plan.rows.map((x) => x['QUERY PLAN']).join('\n')).toContain('forum_threads_title_trgm_idx');
    } finally {
      c.release();
    }
  });
});

describe('0008 thread_reply_counts', () => {
  it('数据库主题与种子主题一起计数，只数已发布回复', async () => {
    const r = await run(
      db.pool,
      anon,
      `select thread_id, replies from public.thread_reply_counts($1) order by 1`,
      [[T.bob, 't-announce', T.alice]],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = Object.fromEntries(r.rows.map((x) => [x.thread_id, Number(x.replies)]));
    // T.bob：5 条已发布 + 1 条隐藏（R.bobHidden）
    expect(m[T.bob]).toBe(5);
    expect(m['t-announce']).toBe(1);
    expect(m[T.alice]).toBeUndefined();
    void R;
  });
  it('一次最多 200 个 key', async () => {
    const keys = Array.from({ length: 300 }, () => T.bob);
    const r = await run(db.pool, anon, `select count(*)::int as n from public.thread_reply_counts($1)`, [
      keys,
    ]);
    expect(r.ok && r.rows[0].n).toBe(1);
  });
});
