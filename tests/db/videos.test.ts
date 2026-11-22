/**
 * T6.7 视频栏目（/videos/）：
 *  - 0014：评论 page_key 允许 video:<slug>（其余前缀不变，非法前缀仍被拒绝），可重复执行；
 *  - 库里已有不合规 page_key 时 0014 跳过替换（给出 warning），不让整个迁移失败。
 * 每个用例在独立事务里执行后回滚（与 PostgREST 一样 SET LOCAL ROLE + request.jwt.claims）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run, verdict } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const SQL = readFileSync(join(MIGRATIONS_DIR, '0014_video_comments.sql'), 'utf8');
const constraintDef = async () =>
  (
    await db.pool.query(
      `select pg_get_constraintdef(oid) d from pg_constraint where conname = 'comments_page_key_check'`,
    )
  ).rows.map((r) => r.d as string);

beforeAll(async () => {
  db = await freshDb('videos');
});
afterAll(async () => {
  await db?.close();
});

const COMMENT = `insert into public.comments (page_key, body, author) values ($1, $2, $3) returning id`;

describe('0014 评论挂在视频页', () => {
  it('登录用户可以在 video:<slug> 页面评论，匿名不行', async () => {
    expect(
      verdict(await run(db.pool, as(U.alice), COMMENT, ['video:designing-claude-code', '好视频', U.alice])),
    ).toBe('allow');
    expect(verdict(await run(db.pool, anon, COMMENT, ['video:designing-claude-code', '匿名', U.alice]))).toBe(
      'deny',
    );
  });
  it('原有前缀照常可用（V72 兼容 + 0013 的 tool:）', async () => {
    for (const key of ['article:x', 'game:x', 'work:x', 'project:fablemotion', 'tool:claude-code'])
      expect(verdict(await run(db.pool, as(U.alice), COMMENT, [key, '评论', U.alice])), key).toBe('allow');
  });
  it('非法前缀 / 非法 slug 被约束拒绝', async () => {
    for (const key of ['videos:x', 'video:Claude', 'video:', 'video:a/b', 'yt:dQw4w9WgXcQ']) {
      const r = await run(db.pool, as(U.alice), COMMENT, [key, '评论', U.alice]);
      expect(r.ok ? 'ok' : r.code, key).toBe('23514');
    }
  });
  it('可重复执行，约束只有一条且同时包含 tool 与 video', async () => {
    await db.pool.query(SQL);
    await db.pool.query(SQL);
    const defs = await constraintDef();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain('tool');
    expect(defs[0]).toContain('video');
  });
  it('库里有不合规的 page_key 时跳过替换，不报错（在事务里验证后回滚）', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query('alter table public.comments drop constraint comments_page_key_check');
      await c.query(`insert into public.comments (page_key, body, author) values ('legacy:odd', 'x', $1)`, [
        U.alice,
      ]);
      // 迁移文件自带 begin / commit；在外层事务里执行时去掉它们
      await c.query(SQL.replace(/^\s*begin;\s*$/m, '').replace(/^\s*commit;\s*$/m, ''));
      const r = await c.query(
        `select count(*)::int n from pg_constraint where conname = 'comments_page_key_check'`,
      );
      expect(r.rows[0].n).toBe(0);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await constraintDef()).toHaveLength(1);
  });
});
