/**
 * 批次 2 跟进 4：定时发布 tick 与隐藏 / 恢复的锁顺序。
 * 约定（0018）：所有路径都先锁内容行、再锁 content_workflow 行；tick 对内容行用 FOR UPDATE SKIP LOCKED，
 * 拿到锁后在锁内重新核对排程状态（review + 已到期 + 未孤儿），被隐藏 / 取消的就跳过。
 *
 * 用两个真实会话强制交错：测试库里把 az_content_table() 换成「application_name = az-test-tick 时先等一个
 * advisory 锁」的版本（只在本测试库，生产函数不变），让 tick 停在「已选中排程行、还没改内容行」这一刻，
 * 再让另一会话隐藏同一条内容。旧实现（先锁排程行、后锁内容行）在这里死锁或把刚隐藏的内容重新公开。
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbUrl } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
const GATE = 424242;
beforeAll(async () => {
  db = await freshDb('b2lock');
  // 测试钩子（仅本库）：tick 会话在解析目标表名时等闸门；其他会话不受影响
  await db.pool.query(`create or replace function public.az_content_table(p_type text)
    returns text language plpgsql volatile set search_path to 'public' as $$
    begin
      if current_setting('application_name', true) = 'az-test-tick' then
        perform pg_advisory_lock(${GATE});
        perform pg_advisory_unlock(${GATE});
      end if;
      return case p_type when 'thread' then 'forum_threads' when 'reply' then 'forum_replies'
                         when 'comment' then 'comments' end;
    end $$`);
}, 90_000);
afterAll(async () => db?.close());

const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
async function client(app: string) {
  const c = new pg.Client({ connectionString: dbUrl(db.name), application_name: app });
  await c.connect();
  return c;
}
async function asMod(c: pg.Client) {
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: U.mia, role: 'authenticated' }),
  ]);
  await c.query('set local role authenticated');
}
async function dueThread(): Promise<string> {
  const [{ id }] = await q(
    `insert into forum_threads (cat, title, body, author, published) values ('技术', $1, 'b', $2, false) returning id`,
    [`lock-${Math.random().toString(36).slice(2, 8)}`, U.bob],
  );
  await q(
    `insert into content_workflow (target_type, target_id, status, scheduled_at) values ('thread', $1, 'review', now() - interval '5 seconds')`,
    [id],
  );
  return id;
}
const state = async (id: string) =>
  (
    await q(
      `select t.published, w.status, w.scheduled_at from forum_threads t
         join content_workflow w on w.target_type = 'thread' and w.target_id = t.id where t.id = $1`,
      [id],
    )
  )[0];
/** 等到某个后端 pid 进入等锁（wait_event_type = Lock / advisory）或 promise 结束 */
async function waitBlockedOrDone(pid: number, done: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (done()) return 'done';
    const [r] = await q(`select wait_event_type, wait_event from pg_stat_activity where pid = $1`, [pid]);
    if (r?.wait_event_type === 'Lock') return r.wait_event as string;
    await new Promise((res) => setTimeout(res, 25));
  }
  return 'timeout';
}
type Settled<T> = { ok: true; v: T } | { ok: false; e: Error & { code?: string } };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );

describe('批次 2 跟进 4：tick 与隐藏的锁顺序（两会话强制交错）', () => {
  it('tick 已选中到期排程、尚未改内容 → 另一会话隐藏同一条：隐藏成功且不被阻塞，tick 不公开、不失败、不死锁', async () => {
    const id = await dueThread();
    const gate = await client('az-test-gate');
    const tick = await client('az-test-tick');
    const hide = await client('az-test-hide');
    try {
      await gate.query(`select pg_advisory_lock(${GATE})`);
      const tickPid = (await tick.query('select pg_backend_pid() as p')).rows[0].p;
      const hidePid = (await hide.query('select pg_backend_pid() as p')).rows[0].p;
      let tickDone = false;
      const tickP = settle(
        tick.query(`select mod_workflow_tick_job('test-lock') as r`).finally(() => (tickDone = true)),
      );
      // tick 停在闸门上（advisory 等待）
      expect(await waitBlockedOrDone(tickPid, () => tickDone)).toBe('advisory');

      let hideDone = false;
      await hide.query('begin');
      await asMod(hide);
      const hideP = settle(
        hide
          .query(`select mod_set_visibility('thread', array[$1]::uuid[], false) as r`, [id])
          .finally(() => (hideDone = true)),
      );
      // 隐藏不应被 tick 持有的排程行锁卡住（旧实现：此处等锁 → 放闸后死锁）
      const hideWait = await waitBlockedOrDone(hidePid, () => hideDone, 3000);
      await gate.query(`select pg_advisory_unlock(${GATE})`);
      const h = await hideP;
      if (h.ok) await hide.query('commit');
      else await hide.query('rollback');
      const t = await tickP;

      const outcome = {
        hide: h.ok ? h.v.rows[0].r.results[0].result : `${h.e.code} ${h.e.message}`,
        tick: t.ok ? t.v.rows[0].r : `${t.e.code} ${t.e.message}`,
        state: await state(id),
        hideWait,
      };
      expect(outcome).toMatchObject({
        hide: 'ok',
        tick: { published: 0, failed: 0 },
        state: { published: false, status: 'offline', scheduled_at: null },
        hideWait: 'done',
      });
      const [{ n }] = await q(
        `select count(*)::int as n from audit_log where target_id = $1 and action in ('content.workflow.scheduled','content.workflow.failed')`,
        [id],
      );
      expect(n).toBe(0);
    } finally {
      await gate.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
      await Promise.all([gate.end(), tick.end(), hide.end()]);
    }
  });

  it('隐藏事务持有内容行锁未提交时 tick 跑：tick 立即返回（SKIP LOCKED，不等锁、不失败）；隐藏提交后再 tick 不会公开', async () => {
    const id = await dueThread();
    const hide = await client('az-test-hide2');
    try {
      await hide.query('begin');
      await asMod(hide);
      await hide.query(`select mod_set_visibility('thread', array[$1]::uuid[], false)`, [id]);
      const t0 = Date.now();
      const [{ r }] = await q(`select mod_workflow_tick_job('test-lock2') as r`);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(r).toMatchObject({ published: 0, failed: 0 });
      await hide.query('commit');
      const [{ r: r2 }] = await q(`select mod_workflow_tick_job('test-lock2') as r`);
      expect(r2.published).toBe(0);
      expect(await state(id)).toMatchObject({ published: false, status: 'offline' });
    } finally {
      await hide.end();
    }
  });

  it('旧前端 PATCH 隐藏（触发器路径）与 tick 交错：同样不死锁、不重新公开', async () => {
    const id = await dueThread();
    const gate = await client('az-test-gate3');
    const tick = await client('az-test-tick');
    const hide = await client('az-test-hide3');
    try {
      await gate.query(`select pg_advisory_lock(${GATE})`);
      const tickPid = (await tick.query('select pg_backend_pid() as p')).rows[0].p;
      const hidePid = (await hide.query('select pg_backend_pid() as p')).rows[0].p;
      let tickDone = false;
      const tickP = settle(
        tick.query(`select mod_workflow_tick_job('test-lock3') as r`).finally(() => (tickDone = true)),
      );
      expect(await waitBlockedOrDone(tickPid, () => tickDone)).toBe('advisory');
      await hide.query('begin');
      await asMod(hide);
      let hideDone = false;
      const hideP = settle(
        hide
          .query(`update forum_threads set published = false where id = $1`, [id])
          .finally(() => (hideDone = true)),
      );
      const hideWait = await waitBlockedOrDone(hidePid, () => hideDone, 3000);
      await gate.query(`select pg_advisory_unlock(${GATE})`);
      const h = await hideP;
      if (h.ok) await hide.query('commit');
      else await hide.query('rollback');
      const t = await tickP;
      const outcome = {
        hide: h.ok ? 'ok' : `${h.e.code} ${h.e.message}`,
        tick: t.ok ? t.v.rows[0].r : `${t.e.code} ${t.e.message}`,
        state: await state(id),
        hideWait,
      };
      expect(outcome).toMatchObject({
        hide: 'ok',
        tick: { published: 0, failed: 0 },
        state: { published: false, status: 'offline', scheduled_at: null },
        hideWait: 'done',
      });
    } finally {
      await gate.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
      await Promise.all([gate.end(), tick.end(), hide.end()]);
    }
  });

  it('恢复后到期 tick 不会对已公开内容再记一次「定时发布」；两个 tick 并发仍各条只发布一次', async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => dueThread()));
    const a = await client('az-test-a');
    const b = await client('az-test-b');
    try {
      const [ra, rb] = await Promise.all([
        a.query(`select mod_workflow_tick_job('test-par') as r`),
        b.query(`select mod_workflow_tick_job('test-par') as r`),
      ]);
      expect(ra.rows[0].r.published + rb.rows[0].r.published).toBe(4);
      expect(ra.rows[0].r.failed + rb.rows[0].r.failed).toBe(0);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    for (const id of ids) {
      const [{ n }] = await q(
        `select count(*)::int as n from audit_log where target_id = $1 and action = 'content.workflow.scheduled'`,
        [id],
      );
      expect(n).toBe(1);
    }
  });
});
