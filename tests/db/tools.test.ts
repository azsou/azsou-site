/**
 * T6.6 AI 工具（/ai/）复用应用商店的数据层：
 *  - 0013：评论 page_key 允许 tool:<slug>（其余前缀不变，非法前缀仍被拒绝），可重复执行；
 *  - 0012 的评价与下载计数只校验 slug 格式，工具 slug 直接可用（不需要迁移）。
 * 每个用例在独立事务里执行后回滚（与 PostgREST 一样 SET LOCAL ROLE + request.jwt.claims）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run, runSeq, verdict } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;

beforeAll(async () => {
  db = await freshDb('tools');
});
afterAll(async () => {
  await db?.close();
});

const COMMENT = `insert into public.comments (page_key, body, author) values ($1, $2, $3) returning id`;

describe('0013 评论挂在 AI 工具页', () => {
  it('登录用户可以在 tool:<slug> 页面评论，匿名不行', async () => {
    expect(verdict(await run(db.pool, as(U.alice), COMMENT, ['tool:claude-code', '好用', U.alice]))).toBe(
      'allow',
    );
    expect(verdict(await run(db.pool, anon, COMMENT, ['tool:claude-code', '匿名', U.alice]))).toBe('deny');
  });
  it('原有前缀照常可用（V72 兼容）', async () => {
    for (const key of ['article:x', 'game:x', 'work:x', 'project:fablemotion'])
      expect(verdict(await run(db.pool, as(U.alice), COMMENT, [key, '评论', U.alice])), key).toBe('allow');
  });
  it('非法前缀 / 非法 slug 被约束拒绝', async () => {
    for (const key of ['ai:claude-code', 'tool:Claude', 'tool:', 'tool:a/b']) {
      const r = await run(db.pool, as(U.alice), COMMENT, [key, '评论', U.alice]);
      expect(r.ok ? 'ok' : r.code, key).toBe('23514');
    }
  });
  it('可重复执行', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_tool_comments.sql'), 'utf8');
    await db.pool.query(sql);
    await db.pool.query(sql);
    const r = await db.pool.query(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'comments_page_key_check'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].d).toContain('tool');
  });
});

describe('AI 工具复用评价与下载计数（0012，无需迁移）', () => {
  it('可以给工具写评价', async () => {
    const r = await run(
      db.pool,
      as(U.alice),
      `insert into public.app_reviews (app, author, rating, title, body) values ('claude-code', $1, 5, '', '好用') returning id`,
      [U.alice],
    );
    expect(verdict(r)).toBe('allow');
  });
  it('/go/<工具>/<平台>/ 的计数 RPC 对工具 slug 正常计数', async () => {
    const UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
    const out = await runSeq(db.pool, anon, [
      [
        `select set_config('request.headers', $1, true)`,
        [JSON.stringify({ 'user-agent': UA, 'x-forwarded-for': '203.0.113.50' })],
      ],
      [`select public.app_count_download('claude-code', 'cli')::int as n`, []],
      [`select public.app_count_download('ollama', 'macos')::int as n`, []],
    ]);
    expect(out[1].ok && Number(out[1].rows![0].n)).toBe(1);
    expect(out[2].ok && Number(out[2].rows![0].n)).toBe(1);
  });
});
