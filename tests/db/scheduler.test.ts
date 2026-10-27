/**
 * A03 / T034（隔离环境）：无人打开后台时由「外部调度器」发布到期内容——经真实本地 PostgREST 以 service_role 调
 * rpc/mod_workflow_tick_job + rpc/az_workflow_alert（scripts/ops/workflow-tick.mjs，与生产接法相同）。
 * 停调度 → 积压超过 2 分钟 → 健康检查不通过并告警；恢复 → 补发且每条只发布一次。
 * 真实生产调度（pg_cron 或外部调度器）尚未启用，需站长批准（docs/OPERATIONS.md「定时发布调度」）。
 */
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIN, ensureAuthenticator, freePort, jwt, startPostgrest, tok } from './postgrest';
import { T, U } from './fixtures';
import { freshDb } from './setup';
// @ts-expect-error -- 纯 JS 运维脚本，无类型声明
import { runTick } from '../../scripts/ops/workflow-tick.mjs';

const enabled = !!BIN;
let db: Awaited<ReturnType<typeof freshDb>>;
let pgrst: ChildProcess | undefined;
let url = '';
beforeAll(async () => {
  if (!enabled) return;
  db = await freshDb('sched');
  await ensureAuthenticator();
  const port = freePort();
  pgrst = await startPostgrest(db.name, port);
  url = `http://127.0.0.1:${port}`;
}, 90_000);
afterAll(async () => {
  pgrst?.kill();
  await db?.close();
});
const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
const SERVICE = () => jwt({ role: 'service_role' });

describe.skipIf(!enabled)('A03 / T034 外部调度器（真实 PostgREST + service_role）', () => {
  it('到期内容由调度器发布（没有任何后台页面参与），写运行记录；每条只发布一次', async () => {
    await q(
      `insert into content_workflow (target_type, target_id, status, scheduled_at) values ('thread', $1, 'review', now() - interval '30 seconds')`,
      [T.bobHidden],
    );
    const r1 = await runTick({ url, restPath: '', key: SERVICE(), source: 'test-external' });
    expect(r1.run).toMatchObject({ published: 1, failed: 0 });
    expect(r1.ok).toBe(true);
    const r2 = await runTick({ url, restPath: '', key: SERVICE(), source: 'test-external' });
    expect(r2.run.published).toBe(0);
    const [{ published }] = await q(`select published from forum_threads where id = $1`, [T.bobHidden]);
    expect(published).toBe(true);
    const [{ n }] = await q(
      `select count(*)::int as n from audit_log where action = 'content.workflow.scheduled' and target_id = $1`,
      [T.bobHidden],
    );
    expect(n).toBe(1);
    const runs = await q(`select source, published from workflow_tick_runs where source = 'test-external' order by id`);
    expect(runs.map((x) => x.published)).toEqual([1, 0]);
  });
  it('调度停摆 → 积压超过 2 分钟：健康检查不通过、告警；恢复后补发', async () => {
    await q(
      `insert into content_workflow (target_type, target_id, status, scheduled_at)
       values ('reply', (select id from forum_replies where author = $1 and published = false limit 1), 'review', now() - interval '6 minutes')`,
      [U.bob],
    );
    const health = await fetch(`${url}/rpc/az_workflow_health`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE()}`, 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json());
    expect(health).toMatchObject({ ok: false });
    expect(health.oldest_overdue_seconds).toBeGreaterThanOrEqual(300);
    const r = await runTick({ url, restPath: '', key: SERVICE(), source: 'test-resume' });
    expect(r.run.published).toBe(1);
    expect(r.ok).toBe(true);
  });
  it('只有 service_role 能调调度入口：版主令牌 / 匿名被拒', async () => {
    await expect(runTick({ url, restPath: '', key: tok(U.mia) })).rejects.toThrow(/HTTP (401|403)/);
    await expect(runTick({ url, restPath: '', key: jwt({ role: 'anon' }) })).rejects.toThrow(/HTTP (401|403)/);
  });
});
