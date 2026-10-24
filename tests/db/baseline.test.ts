/**
 * 0001_baseline.sql 必须精确还原生产库结构：本地跑完 shim + 0001 后取结构快照，
 * 与 db/audit/prod-schema.json（从生产只读导出，见 db/audit/snapshot.sql）逐项比对。
 * 同时演示生产上的已知问题在 baseline 里确实存在（之后的迁移把它们修掉，见 regression.test.ts）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, ROOT, SHIM, run } from './helpers';
import { T, U } from './fixtures';
import { freshDb } from './setup';

const prod = JSON.parse(readFileSync(join(ROOT, 'db/audit/prod-schema.json'), 'utf8')) as Record<
  string,
  unknown[]
>;
const snapshotSql = readFileSync(join(ROOT, 'db/audit/snapshot.sql'), 'utf8');
const canon = (rows: unknown[] | null) =>
  (rows ?? []).map((r) => JSON.stringify(r, Object.keys(r as object).sort())).sort();

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('baseline', { files: [SHIM, join(MIGRATIONS_DIR, '0001_baseline.sql')], seed: false });
}, 60_000);
afterAll(async () => db?.close());

describe('0001_baseline = 生产库结构', () => {
  let local: Record<string, unknown[]>;
  beforeAll(async () => {
    const r = await db.pool.query(snapshotSql);
    local = r.rows[0].snapshot;
  });
  it.each(Object.keys(prod))('%s 一致', (key) => {
    expect(canon(local[key])).toEqual(canon(prod[key]));
  });
});

describe('生产库的已知问题（baseline 中存在，0002+ 修复）', () => {
  beforeAll(async () => {
    await db.pool.query(`insert into auth.users (id, email) values ($1, 'a@x.io'), ($2, 'b@x.io')`, [
      U.alice,
      U.bob,
    ]);
    await db.pool.query(
      `insert into forum_threads (id, cat, title, body, author) values ($1, '产品讨论', 't', 'b', $2)`,
      [T.alice, U.alice],
    );
  });
  const alice = { role: 'authenticated' as const, uid: U.alice };

  it('作者可以把自己的主题置顶、改到「公告」', async () => {
    const r = await run(
      db.pool,
      alice,
      `update forum_threads set pinned = true, cat = '公告' where id = $1`,
      [T.alice],
    );
    expect(r.ok && r.rowCount).toBe(1);
  });
  it('作者可以伪造 created_at', async () => {
    const r = await run(
      db.pool,
      alice,
      `insert into forum_threads (cat, title, body, author, created_at) values ('产品讨论','t','b',$1,'2000-01-01')`,
      [U.alice],
    );
    expect(r.ok).toBe(true);
  });
  it('回复可以挂在不存在的主题上（thread_id 无外键）', async () => {
    const r = await run(
      db.pool,
      alice,
      `insert into forum_replies (thread_id, body, author) values ('00000000-0000-4000-8000-000000000000','r',$1)`,
      [U.alice],
    );
    expect(r.ok).toBe(true);
  });
  it('anon 拥有 TRUNCATE 权限', async () => {
    const r = await db.pool.query(`select has_table_privilege('anon', 'public.comments', 'TRUNCATE') as t`);
    expect(r.rows[0].t).toBe(true);
  });
  it('邮箱前缀超过 40 字时注册失败', async () => {
    await expect(
      db.pool.query(`insert into auth.users (email) values ($1)`, ['x'.repeat(45) + '@example.com']),
    ).rejects.toThrow(/display_name_check/);
  });
});
