/**
 * 批次 2 跟进 5：调度心跳告警。
 * 每次无人值守 tick（mod_workflow_tick_job）写一行心跳（来源 + 时间 + 期望间隔）；az_workflow_health()
 * 在最近一次心跳超过 2× 期望间隔时标记 heartbeat_stale 且 ok = false；az_workflow_alert() 据此告警。
 * 调度器自己停了就没人调 alert——所以版主打开后台时的补偿 tick（mod_workflow_tick）发现心跳过期也会触发告警。
 * 从未有过心跳（生产还没启用调度）不算过期，避免启用前天天误报。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('b2hb');
}, 90_000);
afterAll(async () => db?.close());

const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
const health = async () => (await q(`select az_workflow_health() as h`))[0].h;
const alerts = async () =>
  Number(
    (
      await q(
        `select count(*)::int as n from notifications where kind = 'system' and target_type = 'workflow' and user_id = $1`,
        [U.ada],
      )
    )[0].n,
  );
const age = (sec: number, source = 'cron') =>
  q(`update workflow_scheduler_heartbeat set beat_at = now() - make_interval(secs => $1) where source = $2`, [
    sec,
    source,
  ]);

describe('批次 2 跟进 5：调度心跳', () => {
  it('从未有过心跳：scheduler_configured = false，不算过期，ok 不受影响', async () => {
    const h = await health();
    expect(h).toMatchObject({ scheduler_configured: false, heartbeat_stale: false, ok: true });
  });

  it('每次 tick_job 写 / 更新一行心跳（来源、期望间隔、次数、最近运行）', async () => {
    const [{ r }] = await q(`select mod_workflow_tick_job('cron', 60) as r`);
    let [hb] = await q(`select * from workflow_scheduler_heartbeat where source = 'cron'`);
    expect(hb).toMatchObject({ interval_seconds: 60, beats: '1' });
    expect(Number(hb.last_run_id)).toBe(Number(r.run_id));
    await q(`select mod_workflow_tick_job('cron', 60)`);
    [hb] = await q(`select * from workflow_scheduler_heartbeat where source = 'cron'`);
    expect(hb.beats).toBe('2');
    expect(await health()).toMatchObject({
      scheduler_configured: true,
      heartbeat_source: 'cron',
      heartbeat_interval_seconds: 60,
      heartbeat_stale: false,
      ok: true,
    });
  });

  it('期望间隔必须在 10 秒–1 天之间', async () => {
    await expect(q(`select mod_workflow_tick_job('cron', 5)`)).rejects.toMatchObject({ code: '22023' });
    await expect(q(`select mod_workflow_tick_job('cron', 90000)`)).rejects.toMatchObject({ code: '22023' });
  });

  it('心跳 1.5× 间隔：未过期；超过 2× 间隔：heartbeat_stale = true、ok = false', async () => {
    await q(`select mod_workflow_tick_job('cron', 60)`);
    await age(90);
    expect(await health()).toMatchObject({ heartbeat_stale: false, ok: true });
    await age(121);
    const h = await health();
    expect(h).toMatchObject({ heartbeat_stale: true, ok: false });
    expect(h.heartbeat_age_seconds).toBeGreaterThanOrEqual(121);
  });

  it('心跳过期 → az_workflow_alert 给管理员发系统通知（文案提到心跳）并写审计；1 小时内不重复', async () => {
    await age(600);
    const before = await alerts();
    const [{ r }] = await q(`select az_workflow_alert() as r`);
    expect(r).toMatchObject({ alerted: true, heartbeat_stale: true });
    expect(await alerts()).toBe(before + 1);
    const [n] = await q(
      `select excerpt from notifications where kind = 'system' and target_type = 'workflow' and user_id = $1 order by created_at desc limit 1`,
      [U.ada],
    );
    expect(n.excerpt).toMatch(/心跳/);
    const [a] = await q(
      `select detail from audit_log where action = 'content.workflow.alert' order by id desc limit 1`,
    );
    expect(a.detail).toMatchObject({ heartbeat_stale: true });
    const [{ r: r2 }] = await q(`select az_workflow_alert() as r`);
    expect(r2).toMatchObject({ alerted: false, suppressed: true });
  });

  it('调度器停了没人调 alert：版主打开后台的补偿 tick 发现心跳过期会触发告警；心跳恢复后不再告警', async () => {
    await q(`delete from notifications where kind = 'system' and target_type = 'workflow'`);
    await age(600);
    const o = await run(
      db.pool,
      { role: 'authenticated', uid: U.mia },
      `select mod_workflow_tick() as n`,
      [],
      {
        commit: true,
      },
    );
    expect(o.ok).toBe(true);
    expect(await alerts()).toBe(1);
    // 补偿 tick 不写心跳（后台页面不是调度器）
    const [hb] = await q(
      `select extract(epoch from now() - beat_at) as a from workflow_scheduler_heartbeat where source = 'cron'`,
    );
    expect(Number(hb.a)).toBeGreaterThanOrEqual(600);
    // 调度恢复
    await q(`delete from notifications where kind = 'system' and target_type = 'workflow'`);
    await q(`select mod_workflow_tick_job('cron', 60)`);
    expect(await health()).toMatchObject({ heartbeat_stale: false, ok: true });
    await run(db.pool, { role: 'authenticated', uid: U.mia }, `select mod_workflow_tick()`, [], {
      commit: true,
    });
    expect(await alerts()).toBe(0);
  });

  it('心跳表：版主可读（后台展示），普通用户 / 匿名读不到；任何 API 角色都不能直接写', async () => {
    const mod = await run(
      db.pool,
      { role: 'authenticated', uid: U.mia },
      `select source from workflow_scheduler_heartbeat`,
    );
    expect(mod.ok && mod.rowCount).toBeGreaterThan(0);
    const alice = await run(
      db.pool,
      { role: 'authenticated', uid: U.alice },
      `select source from workflow_scheduler_heartbeat`,
    );
    expect(alice.ok ? alice.rowCount : 0).toBe(0);
    const anon = await run(db.pool, { role: 'anon' }, `select source from workflow_scheduler_heartbeat`);
    expect(anon.ok).toBe(false);
    const w = await run(
      db.pool,
      { role: 'authenticated', uid: U.ada },
      `update workflow_scheduler_heartbeat set beat_at = now()`,
    );
    expect(w.ok).toBe(false);
  });
});
