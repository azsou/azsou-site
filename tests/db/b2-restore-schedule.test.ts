/**
 * 站长决定（2026-10-27 定稿）：
 *   ① 手工隐藏「待审 + 定时发布」的内容默认取消排程（开关 az_hide_cancels_schedule() 保留、默认 true）；
 *   ② 恢复（取消隐藏）不会复活旧排程；被取消的排程只留在审计里，需要重新排程时由版主手工再设。
 * 站长第二轮（2026-10-27 21:06，取代「恢复即公开」）：恢复默认回到「待审」（published=false、排程为空），
 *   公开必须走显式「发布」mod_publish_content（版主 / 管理员，逐项结果、幂等键、写 content.published 审计）。
 * 两条路径都覆盖：统一接口 mod_set_visibility 与旧前端直接 PATCH published（触发器 az_workflow_sync）。
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrl, run, type Outcome, type Who } from './helpers';
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

  it('mod_set_visibility：隐藏取消排程并在审计里留下被取消的时间；恢复 = 回到待审（不公开）、排程为空、审计 schedule_revived=false', async () => {
    const { id, at } = await scheduledHidden();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'offline', scheduled_at: null });
    const hide = await lastAudit('content.visibility', id);
    expect(hide).toMatchObject({ published: false, schedule_cancelled: true });
    expect(new Date(hide.cancelled_scheduled_at).toISOString()).toBe(new Date(at).toISOString());

    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true)`, [id]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'review', scheduled_at: null });
    expect(await lastAudit('content.visibility', id)).toMatchObject({
      restored: true,
      published: false,
      status: 'review',
      schedule_revived: false,
    });

    // 原排程时间到了也不会有第二次「定时发布」，恢复后的待审内容也不会被 tick 公开
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
    expect((await wf(id)).published).toBe(false);
    expect(await auditCount('content.workflow.scheduled', id)).toBe(0);
  });

  it('隐藏 → 恢复 → 再隐藏：不会冒出旧排程；再恢复仍为待审、排程为空', async () => {
    const { id } = await scheduledHidden();
    for (const pub of [false, true, false, true])
      ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], $2)`, [id, pub]));
    expect(await wf(id)).toMatchObject({ published: false, status: 'review', scheduled_at: null });
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
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

  it('开关改为 false（仅本连接的事务内模拟）：隐藏保留排程；但「恢复」仍回到待审并清空排程，不会到点发布', async () => {
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
      expect(after).toMatchObject({ status: 'review', scheduled_at: null });
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
      expect(audit).toMatchObject({ restored: true, published: false, schedule_revived: false });
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
    const [v] = await q(`select public.az_hide_cancels_schedule() as v`);
    expect(v.v).toBe(true); // 回滚后仍是站长定的默认值
  });
});

describe('站长第二轮：恢复 → 待审；显式「发布」mod_publish_content', () => {
  const pub = (id: string, key: string | null = null, who: Who = mia) =>
    run(db.pool, who, `select mod_publish_content('thread', array[$1]::uuid[], $2) as r`, [id, key], {
      commit: true,
    });
  const anonSees = async (id: string) => {
    const o = await run(db.pool, { role: 'anon' }, `select id from forum_threads where id = $1`, [id]);
    return o.ok && o.rowCount === 1;
  };

  it('普通已公开内容：隐藏 → 恢复 = 待审（匿名不可见）→ 发布 = 公开；审计 content.published 带来源状态', async () => {
    const id = await mkThread();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    const r = ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true) as r`, [id]));
    expect(r[0].r).toMatchObject({ ok: 1, failed: 0, results: [{ id, result: 'ok' }] });
    expect(await wf(id)).toMatchObject({ published: false, status: 'review', scheduled_at: null });
    expect(await anonSees(id)).toBe(false);

    const p = ok(await pub(id));
    expect(p[0].r).toMatchObject({ ok: 1, failed: 0, results: [{ id, result: 'ok' }] });
    expect(await wf(id)).toMatchObject({ published: true, status: 'published', scheduled_at: null });
    expect(await anonSees(id)).toBe(true);
    expect(await lastAudit('content.published', id)).toMatchObject({
      from_status: 'review',
      published: true,
    });
  });

  it('对已公开内容点「恢复」不会把它降回待审（unchanged）', async () => {
    const id = await mkThread();
    ok(await act(`select mod_workflow_apply('thread', array[$1]::uuid[], 'published')`, [id]));
    const r = ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true) as r`, [id]));
    expect(r[0].r.results[0].result).toBe('unchanged');
    expect(await wf(id)).toMatchObject({ published: true, status: 'published' });
  });

  it('发布：已公开 → unchanged；同一幂等键重试不重复执行；待审 + 定时的内容发布 = 立即公开并清空排程（审计记被取消的时间）', async () => {
    const id = await mkThread();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true)`, [id]));
    const key = `pub-${id}`;
    expect(ok(await pub(id, key))[0].r).toMatchObject({ ok: 1, replayed: false });
    expect(ok(await pub(id, key))[0].r).toMatchObject({ ok: 1, replayed: true });
    expect(await auditCount('content.published', id)).toBe(1);
    expect(ok(await pub(id))[0].r.results[0].result).toBe('unchanged');

    const { id: s, at } = await scheduledHidden();
    ok(await pub(s));
    expect(await wf(s)).toMatchObject({ published: true, status: 'published', scheduled_at: null });
    const a = await lastAudit('content.published', s);
    expect(new Date(a.cancelled_scheduled_at).toISOString()).toBe(new Date(at).toISOString());
  });

  it('恢复永不复活排程：定时内容 → 隐藏 → 恢复 → 原时间到期 tick → 仍是待审、未公开；只有显式发布才公开', async () => {
    const { id } = await scheduledHidden();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], true)`, [id]));
    // 即使有人把旧时间写回去再拨到过去，恢复后的状态也不带排程——tick 无事可做
    const r = await tickAsIfOldScheduleDue(id);
    expect(r.published).toBe(0);
    expect(await wf(id)).toMatchObject({ published: false, status: 'review', scheduled_at: null });
    expect(await auditCount('content.workflow.scheduled', id)).toBe(0);
    ok(await pub(id));
    expect((await wf(id)).published).toBe(true);
  });

  it('权限：普通用户与匿名不能发布；不存在的 id 返回 not_found；一次最多 200 条', async () => {
    const id = await mkThread();
    ok(await act(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]));
    const bob = await pub(id, null, { role: 'authenticated', uid: U.bob });
    expect(bob.ok).toBe(false);
    const anon = await run(
      db.pool,
      { role: 'anon' },
      `select mod_publish_content('thread', array[$1]::uuid[])`,
      [id],
    );
    expect(anon.ok).toBe(false);
    expect((await wf(id)).published).toBe(false);
    const ghost = '00000000-0000-4000-a000-0000000000ff';
    expect(ok(await pub(ghost))[0].r.results[0].result).toBe('not_found');
    const many = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-b000-${String(i).padStart(12, '0')}`,
    );
    const big = await run(db.pool, mia, `select mod_publish_content('thread', $1::uuid[])`, [many]);
    expect(big.ok).toBe(false);
    // 管理员同样可以发布
    expect(ok(await pub(id, null, { role: 'authenticated', uid: U.ada }))[0].r.ok).toBe(1);
  });
});
