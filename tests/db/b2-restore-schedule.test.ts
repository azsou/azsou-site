/**
 * 站长决定（2026-10-27 定稿）：
 *   ① 手工隐藏「待审 + 定时发布」的内容默认取消排程（开关 az_hide_cancels_schedule() 保留、默认 true）；
 *   ② 恢复（取消隐藏）不会复活旧排程——恢复就是「现在公开」，排程字段清空；被取消的排程只留在审计里，
 *      需要重新排程时由版主手工再设。
 * 两条路径都覆盖：统一接口 mod_set_visibility 与旧前端直接 PATCH published（触发器 az_workflow_sync）。
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrl, run, type Outcome } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('b2rs');
}, 90_000);
afterAll(async () => db?.close());

const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
const mia = { role: 'authenticated' as const, uid: U.mia };
const act = (sql: string, p: unknown[] = []): Promise<Outcome> => run(db.pool, mia, sql, p, { commit: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 逐列断言 jsonb
const ok = (o: Outcome): any[] => {
  if (!o.ok) throw new Error(`期望成功，实际 ${o.code}: ${o.message}`);
  return o.rows;
};
const future = () => new Date(Date.now() + 3600_000).toISOString();

async function mkThread(): Promise<string> {
  const title = `rs-${Math.random().toString(36).slice(2, 8)}`;
  return (
    await q(
      `insert into forum_threads (cat, title, body, author) values ('技术', $1, 'body', $2) returning id`,
      [title, U.bob],
    )
  )[0].id;
}
const wf = async (id: string) =>
  (
    await q(
      `select t.published, w.status, w.scheduled_at from forum_threads t
         left join content_workflow w on w.target_type = 'thread' and w.target_id = t.id where t.id = $1`,
      [id],
    )
  )[0];
const lastAudit = async (action: string, id: string) =>
  (
    await q(`select detail from audit_log where action = $1 and target_id = $2 order by id desc limit 1`, [
      action,
      id,
    ])
  )[0]?.detail;
const auditCount = async (action: string, id: string) =>
  Number(
    (await q(`select count(*) from audit_log where action = $1 and target_id = $2`, [action, id]))[0].count,
  );
/** 把 content_workflow 里任何残留排程拨到过去，再跑一次无人值守 tick：若旧排程被「复活」就会在这里重新发布 */
async function tickAsIfOldScheduleDue(id: string) {
  await q(
    `update content_workflow set scheduled_at = now() - interval '1 second'
      where target_type = 'thread' and target_id = $1 and scheduled_at is not null`,
    [id],
  );
  return (await q(`select mod_workflow_tick_job('test-restore') as r`))[0].r;
}
async function scheduledHidden(): Promise<{ id: string; at: string }> {
  const id = await mkThread();
  const at = future();
  ok(await act(`select mod_workflow_apply('thread', array[$1]::uuid[], 'review', $2)`, [id, at]));
  return { id, at };
}

describe('站长决定：隐藏取消排程（默认）；恢复不复活旧排程', () => {
  it('开关 az_hide_cancels_schedule() 默认 true，注释写明「站长已定」', async () => {
    const [r] = await q(`select public.az_hide_cancels_schedule() as v,
                                obj_description('public.az_hide_cancels_schedule()'::regprocedure) as c`);
    expect(r.v).toBe(true);
    expect(r.c).toMatch(/站长.*2026-10-27/);
  });

  it('mod_set_visibility：隐藏取消排程并在审计里留下被取消的时间；恢复 = 立即公开、排程为空、审计 schedule_revived=false', async () => {
    const { id, at } = await scheduledHidden();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'offline', scheduled_at: null });
    const hide = await lastAudit('content.visibility', id);
    expect(hide).toMatchObject({ published: false, schedule_cancelled: true });
    expect(new Date(hide.cancelled_scheduled_at).toISOString()).toBe(new Date(at).toISOString());

    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true)`, [id]));
    expect(await wf(id)).toMatchObject({ published: true, status: 'published', scheduled_at: null });
    expect(await lastAudit('content.visibility', id)).toMatchObject({
      published: true,
      schedule_revived: false,
    });

    // 原排程时间到了也不会有第二次「定时发布」
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
    expect(await auditCount('content.workflow.scheduled', id)).toBe(0);
  });

  it('隐藏 → 恢复 → 再隐藏：不会冒出旧排程；再恢复仍为空', async () => {
    const { id } = await scheduledHidden();
    for (const pub of [false, true, false, true])
      ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], $2)`, [id, pub]));
    expect(await wf(id)).toMatchObject({ published: true, scheduled_at: null });
  });

  it('隐藏后改回「待审」（不填时间）：旧排程不会被带回', async () => {
    const { id } = await scheduledHidden();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    ok(await act(`select mod_workflow_apply('thread', array[$1]::uuid[], 'review')`, [id]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'review', scheduled_at: null });
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
    expect((await wf(id)).published).toBe(false);
  });

  it('旧前端直接 PATCH：隐藏取消排程并写 content.workflow.schedule_cancelled 审计；PATCH 恢复不复活排程', async () => {
    const { id, at } = await scheduledHidden();
    ok(await act(`update forum_threads set published = false where id = $1`, [id]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'offline', scheduled_at: null });
    const a = await lastAudit('content.workflow.schedule_cancelled', id);
    expect(a).toBeTruthy();
    expect(new Date(a.cancelled_scheduled_at).toISOString()).toBe(new Date(at).toISOString());
    ok(await act(`update forum_threads set published = true where id = $1`, [id]));
    expect(await wf(id)).toMatchObject({ published: true, status: 'published', scheduled_at: null });
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
  });

  it('开关改为 false（仅本连接的事务内模拟）：隐藏保留排程；但「恢复」仍是立即公开并清空排程，不会再到点重复发布', async () => {
    const { id } = await scheduledHidden();
    const c = new pg.Client({ connectionString: dbUrl(db.name) });
    await c.connect();
    try {
      await c.query('begin');
      await c.query(`create or replace function public.az_hide_cancels_schedule() returns boolean
                      language sql immutable set search_path to 'public' as $$ select false $$`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.mia, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      await c.query(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]);
      const kept = (
        await c.query(`select status, scheduled_at from content_workflow where target_id = $1`, [id])
      ).rows[0];
      expect(kept.status).toBe('review');
      expect(kept.scheduled_at).not.toBeNull();
      const r = (await c.query(`select mod_set_visibility('thread', array[$1]::uuid[], true) as r`, [id]))
        .rows[0].r;
      expect(r.ok).toBe(1);
      const after = (
        await c.query(`select status, scheduled_at from content_workflow where target_id = $1`, [id])
      ).rows[0];
      expect(after).toMatchObject({ status: 'published', scheduled_at: null });
      const audit = (
        await c
          .query(`reset role`)
          .then(() =>
            c.query(
              `select detail from audit_log where action = 'content.visibility' and target_id = $1 order by id desc limit 1`,
              [id],
            ),
          )
      ).rows[0].detail;
      expect(audit).toMatchObject({ published: true, schedule_revived: false });
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
    const [v] = await q(`select public.az_hide_cancels_schedule() as v`);
    expect(v.v).toBe(true); // 回滚后仍是站长定的默认值
  });
});
