/**
 * 批次 2 跟进 6：内容版本保留 90 天（站长 2026-10-27 定稿）。
 * az_prune_content_versions(p_days default 90) 删除早于保留期的版本，返回删除条数并写审计；
 * 不允许小于 90 天（防止误删）；只给表所有者 / service_role。0018 只建函数，不排任何定时任务——
 * 生产上何时开始按周清理随「开启调度」放行申请一起审批（docs/release/）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './helpers';
import { T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('b2ver');
}, 90_000);
afterAll(async () => db?.close());
const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;

async function seedVersions() {
  await q(`delete from content_versions`);
  for (const [tag, days] of [
    ['old-200', 200],
    ['old-91', 91],
    ['edge-89', 89],
    ['new-1', 1],
    ['new-0', 0],
  ] as const)
    await q(
      `insert into content_versions (target_type, target_id, title, body, editor, created_at)
       values ('thread', $1, $2, 'v', $3, now() - make_interval(days => $4))`,
      [T.bob, tag, U.ada, days],
    );
}
const titles = async () =>
  (await q(`select title from content_versions order by created_at`)).map((r) => r.title);

describe('批次 2 跟进 6：内容版本保留 90 天', () => {
  it('默认 90 天：只删早于 90 天的版本，返回条数并写审计；再跑一次删 0 条', async () => {
    await seedVersions();
    const [{ n }] = await q(`select az_prune_content_versions() as n`);
    expect(n).toBe(2);
    expect(await titles()).toEqual(['edge-89', 'new-1', 'new-0']);
    const [a] = await q(
      `select detail from audit_log where action = 'content.versions.pruned' order by id desc limit 1`,
    );
    expect(a.detail).toMatchObject({ deleted: 2, retention_days: 90 });
    const [{ n: n2 }] = await q(`select az_prune_content_versions() as n`);
    expect(n2).toBe(0);
  });

  it('可以保留更久（如 120 天），但不允许短于 90 天', async () => {
    await seedVersions();
    const [{ n }] = await q(`select az_prune_content_versions(120) as n`);
    expect(n).toBe(1);
    expect(await titles()).toEqual(['old-91', 'edge-89', 'new-1', 'new-0']);
    await expect(q(`select az_prune_content_versions(30)`)).rejects.toMatchObject({ code: '22023' });
    await expect(q(`select az_prune_content_versions(null)`)).rejects.toMatchObject({ code: '22023' });
    expect((await titles()).length).toBe(4);
  });

  it('只给表所有者 / service_role：管理员令牌、版主、匿名都不能调用', async () => {
    for (const who of [
      { role: 'authenticated' as const, uid: U.ada },
      { role: 'authenticated' as const, uid: U.mia },
      { role: 'anon' as const },
    ]) {
      const o = await run(db.pool, who, `select az_prune_content_versions()`);
      expect(o.ok).toBe(false);
    }
    const [{ ok }] = await q(
      `select has_function_privilege('service_role', 'public.az_prune_content_versions(integer)', 'execute') as ok`,
    );
    expect(ok).toBe(true);
  });

  it('0018 不创建任何定时任务（没有 cron schema 的调用；清理需要站长另批）', async () => {
    const [{ src }] = await q(
      `select pg_get_functiondef('public.az_prune_content_versions(integer)'::regprocedure) as src`,
    );
    expect(src).not.toMatch(/cron\./);
  });
});
