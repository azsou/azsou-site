/**
 * 交接批次 2（docs/audits/2026-10-27-hark-handoff.md）：状态一致性、调度、权限、并发、分页、审计。
 * 每条用例名带任务 / 用例 ID；全部跑在真实 PostgreSQL（shim + 全部迁移 + 夹具）上，按 PostgREST 的方式
 * SET LOCAL ROLE + request.jwt.claims 扮演角色。失败优先：先在 0001–0017 上跑出失败（证据见
 * docs/audits/evidence/batch2/），再由 0018 + 前端修复转绿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, type Outcome } from './helpers';
import { C, R, T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('batch2');
}, 90_000);
afterAll(async () => db?.close());

type Who = keyof typeof U;
const as = (who: Who) => ({ role: 'authenticated' as const, uid: U[who] });
const anon = { role: 'anon' as const };
/** 超级用户直接查询（相当于 SQL 控制台 / pg_cron 的表所有者身份） */
const q = async (sql: string, p: unknown[] = []) => (await db.pool.query(sql, p)).rows;
/** 以某个身份执行并提交 */
const act = (who: Who | 'anon', sql: string, p: unknown[] = []): Promise<Outcome> =>
  run(db.pool, who === 'anon' ? anon : as(who), sql, p, { commit: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里逐列断言 SQL 返回的 jsonb
const ok = (o: Outcome): any[] => {
  if (!o.ok) throw new Error(`期望成功，实际 ${o.code}: ${o.message}`);
  return o.rows;
};
const changed = (o: Outcome) => (o.ok ? o.rowCount : 0);
const TABLE = { thread: 'forum_threads', reply: 'forum_replies', comment: 'comments' } as const;
type Kind = keyof typeof TABLE;

/** 新建一条属于 bob 的内容（超级用户写，不触发 API 守卫），返回 id */
async function mk(kind: Kind, extra = ''): Promise<string> {
  const title = `b2-${kind}-${Math.random().toString(36).slice(2, 8)}${extra}`;
  if (kind === 'thread')
    return (
      await q(
        `insert into forum_threads (cat, title, body, author) values ('技术', $1, 'body', $2) returning id`,
        [title, U.bob],
      )
    )[0].id;
  if (kind === 'reply')
    return (
      await q(`insert into forum_replies (thread_id, body, author) values ($1, $2, $3) returning id`, [
        T.bob,
        title,
        U.bob,
      ])
    )[0].id;
  return (
    await q(`insert into comments (page_key, body, author) values ('article:b2', $1, $2) returning id`, [
      title,
      U.bob,
    ])
  )[0].id;
}
const state = async (kind: Kind, id: string) => {
  const [row] = await q(`select published from ${TABLE[kind]} where id = $1`, [id]);
  const [wf] = await q(
    `select status, scheduled_at, orphaned_at from content_workflow where target_type = $1 and target_id = $2`,
    [kind, id],
  ).catch(async () =>
    q(
      `select status, scheduled_at, null as orphaned_at from content_workflow where target_type = $1 and target_id = $2`,
      [kind, id],
    ),
  );
  return { published: row?.published as boolean | undefined, wf };
};
const anonSees = async (kind: Kind, id: string) => {
  const r = await run(db.pool, anon, `select id from ${TABLE[kind]} where id = $1`, [id]);
  return r.ok && r.rowCount === 1;
};
/** 把排程时间拨到过去（等价于「测试时钟推进到到期」） */
const makeDue = (kind: Kind, id: string) =>
  q(
    `update content_workflow set scheduled_at = now() - interval '1 second' where target_type = $1 and target_id = $2`,
    [kind, id],
  );
const future = () => new Date(Date.now() + 3600_000).toISOString();
const auditCount = async (action: string, id: string) =>
  Number(
    (await q(`select count(*) from audit_log where action = $1 and target_id = $2`, [action, id]))[0].count,
  );

const KINDS: Kind[] = ['thread', 'reply', 'comment'];

// ------------------------------------------------------------------ A01 ----
describe('A01 / T032 工作流与公开标志一致', () => {
  for (const kind of KINDS)
    it(`${kind}：直接 PATCH published（旧「隐藏 / 恢复」路径）后 workflow 与公开标志、匿名可见性一致`, async () => {
      const id = await mk(kind);
      ok(await act('mia', `select mod_set_workflow($1, array[$2]::uuid[], 'draft')`, [kind, id]));
      expect(await state(kind, id)).toMatchObject({ published: false, wf: { status: 'draft' } });
      // 旧版后台 setPublished / 前台版主按钮：PostgREST PATCH {published:true}
      ok(await act('mia', `update ${TABLE[kind]} set published = true where id = $1`, [id]));
      const s = await state(kind, id);
      expect(s.published).toBe(true);
      expect(s.wf?.status).toBe('published');
      expect(await anonSees(kind, id)).toBe(true);
      // 再隐藏：workflow 变 offline，匿名不可见
      ok(await act('mia', `update ${TABLE[kind]} set published = false where id = $1`, [id]));
      const h = await state(kind, id);
      expect(h).toMatchObject({ published: false, wf: { status: 'offline' } });
      expect(await anonSees(kind, id)).toBe(false);
      // 后台列表徽标（mod_list_content.wf_status）与 published 一致
      const l = ok(
        await act(
          'mia',
          `select published, wf_status from mod_list_content($1, p_limit => 100) where id = $2`,
          [kind, id],
        ),
      );
      expect(l[0]).toMatchObject({ published: false, wf_status: 'offline' });
    });

  it('统一接口 mod_set_visibility：隐藏 / 恢复返回逐项结果并同步 workflow', async () => {
    const id = await mk('thread');
    const r = ok(
      await act('mia', `select mod_set_visibility('thread', array[$1]::uuid[], false) as r`, [id]),
    );
    expect(r[0].r).toMatchObject({ ok: 1, results: [{ id, result: 'ok' }] });
    expect(await state('thread', id)).toMatchObject({ published: false, wf: { status: 'offline' } });
    ok(await act('mia', `select mod_set_visibility('thread', array[$1]::uuid[], true)`, [id]));
    expect(await state('thread', id)).toMatchObject({ published: true, wf: { status: 'published' } });
  });
});

describe('A01 / T063 手工隐藏排程内容的取消语义（默认：隐藏 = 取消排程，待站长确认）', () => {
  for (const kind of KINDS)
    it(`${kind}：review + 未来时间 → 手工隐藏 → 到期 tick 不得重新公开`, async () => {
      const id = await mk(kind);
      ok(
        await act('mia', `select mod_set_workflow($1, array[$2]::uuid[], 'review', $3)`, [
          kind,
          id,
          future(),
        ]),
      );
      // 旧路径：PATCH {published:false}（内容本来就未公开，但版主点了「隐藏」）
      ok(await act('mia', `update ${TABLE[kind]} set published = false where id = $1`, [id]));
      const hidden = await state(kind, id);
      expect(hidden.wf?.scheduled_at ?? null).toBeNull(); // 排程已取消
      // 即使有人把时间拨到过去（等价于原排程到期），tick 也不得公开
      await makeDue(kind, id);
      await q(`select mod_workflow_tick()`);
      const s = await state(kind, id);
      expect(s.published).toBe(false);
      expect(await anonSees(kind, id)).toBe(false);
    });

  it('开关 az_hide_cancels_schedule() 存在且默认 true（唯一的策略开关）', async () => {
    const [r] = await q(`select public.az_hide_cancels_schedule() as v`);
    expect(r.v).toBe(true);
  });
});

// ------------------------------------------------------------------ A02 ----
describe('A02 / T033 删除排程目标后 tick', () => {
  for (const kind of KINDS)
    it(`${kind}：目标已删 → tick 不计成功、不写成功审计、排程标记为孤儿并留异常审计`, async () => {
      const id = await mk(kind);
      ok(
        await act('mia', `select mod_set_workflow($1, array[$2]::uuid[], 'review', $3)`, [
          kind,
          id,
          future(),
        ]),
      );
      await makeDue(kind, id);
      await q(`delete from ${TABLE[kind]} where id = $1`, [id]);
      const [{ n }] = await q(`select mod_workflow_tick() as n`);
      expect(n).toBe(0);
      expect(await auditCount('content.workflow.scheduled', id)).toBe(0);
      expect(await auditCount('content.workflow.orphaned', id)).toBe(1);
      const [wf] = await q(
        `select status, scheduled_at, orphaned_at from content_workflow where target_id = $1`,
        [id],
      );
      expect(wf.scheduled_at).toBeNull();
      expect(wf.orphaned_at).not.toBeNull();
    });

  it('tick 循环中途目标被并发删除：本行计入孤儿，不是成功', async () => {
    const id = await mk('thread');
    ok(
      await act('mia', `select mod_set_workflow('thread', array[$1]::uuid[], 'review', $2)`, [id, future()]),
    );
    await makeDue('thread', id);
    // 模拟「已选中排程、UPDATE 前目标被删」：直接删 workflow 之外的目标但保留排程行——用触发器关闭期复现
    await q(`alter table forum_threads disable trigger user`);
    try {
      await q(`delete from forum_threads where id = $1`, [id]);
    } finally {
      await q(`alter table forum_threads enable trigger user`);
    }
    const [{ n }] = await q(`select mod_workflow_tick() as n`);
    expect(n).toBe(0);
    expect(await auditCount('content.workflow.scheduled', id)).toBe(0);
    expect(await auditCount('content.workflow.orphaned', id)).toBe(1);
  });
});

// ------------------------------------------------------------- A03 / T061/T062
describe('A03 / T061 未到期排程绝不提前发布', () => {
  it('未来时间：tick 多次返回 0 且匿名不可见；到期后只发布一次', async () => {
    const id = await mk('reply');
    ok(await act('mia', `select mod_set_workflow('reply', array[$1]::uuid[], 'review', $2)`, [id, future()]));
    for (let i = 0; i < 3; i++) await q(`select mod_workflow_tick()`);
    expect(await anonSees('reply', id)).toBe(false);
    await makeDue('reply', id);
    await q(`select mod_workflow_tick()`);
    await q(`select mod_workflow_tick()`);
    expect(await anonSees('reply', id)).toBe(true);
    expect(await auditCount('content.workflow.scheduled', id)).toBe(1);
  });
});

describe('A03 / T062 双 worker 并发 tick 幂等', () => {
  it('两个连接同时 tick：成功合计 = 真实到期数，每条成功审计仅一次', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => mk('comment')));
    ok(await act('mia', `select mod_set_workflow('comment', $1::uuid[], 'review', $2)`, [ids, future()]));
    for (const id of ids) await makeDue('comment', id);
    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      await c1.query('begin');
      await c2.query('begin');
      const p1 = c1.query(`select mod_workflow_tick() as n`);
      const p2 = c2.query(`select mod_workflow_tick() as n`);
      const [r1, r2] = await Promise.all([p1, p2]);
      await c1.query('commit');
      await c2.query('commit');
      const total = Number(r1.rows[0].n) + Number(r2.rows[0].n);
      expect(total).toBe(5);
    } finally {
      c1.release();
      c2.release();
    }
    for (const id of ids) expect(await auditCount('content.workflow.scheduled', id)).toBe(1);
  });
});

describe('A03 无人值守调度入口 + 运行记录 + 健康检查（告警数据源）', () => {
  it('mod_workflow_tick_job 返回汇总并写 workflow_tick_runs；az_workflow_health 能看出积压与上次运行', async () => {
    const id = await mk('thread');
    ok(
      await act('mia', `select mod_set_workflow('thread', array[$1]::uuid[], 'review', $2)`, [id, future()]),
    );
    // 到期 5 分钟仍未发布 = 超出「到期 2 分钟内可见」的承诺，应告警
    await q(`update content_workflow set scheduled_at = now() - interval '5 minutes' where target_id = $1`, [
      id,
    ]);
    const [h0] = await q(`select az_workflow_health() as h`);
    expect(h0.h.overdue).toBeGreaterThanOrEqual(1);
    expect(h0.h.ok).toBe(false);
    const [j] = await q(`select mod_workflow_tick_job('test') as j`);
    expect(j.j).toMatchObject({ published: 1, orphaned: 0, failed: 0 });
    const [run_] = await q(
      `select source, published, failed, finished_at from workflow_tick_runs order by id desc limit 1`,
    );
    expect(run_).toMatchObject({ source: 'test', published: 1, failed: 0 });
    expect(run_.finished_at).not.toBeNull();
    const [h1] = await q(`select az_workflow_health() as h`);
    expect(h1.h).toMatchObject({ overdue: 0, ok: true });
  });
  it('调度入口只给表所有者 / service_role：普通登录用户、匿名都不能直接调 tick_job', async () => {
    expect((await act('alice', `select mod_workflow_tick_job('x')`)).ok).toBe(false);
    expect((await act('anon', `select mod_workflow_tick_job('x')`)).ok).toBe(false);
    expect((await act('mia', `select mod_workflow_tick_job('x')`)).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ A04 ----
describe('A04 / T035 版主字段权限矩阵（默认：版主只改审核标志，正文编辑走管理员 RPC，待站长确认）', () => {
  it('版主直接 PATCH 他人主题的 title / body / cat 被拒，数据不变', async () => {
    for (const [col, val] of [
      ['title', '版主改的标题'],
      ['body', '版主改的正文'],
      ['cat', '闲聊'],
    ] as const) {
      const r = await act('mia', `update forum_threads set ${col} = $2 where id = $1`, [T.bob, val]);
      expect(r.ok ? 'allow' : r.code, col).toBe('42501');
    }
    const [row] = await q(`select title, body, cat from forum_threads where id = $1`, [T.bob]);
    expect(row.title).not.toBe('版主改的标题');
    expect(row.body).not.toBe('版主改的正文');
  });
  it('版主直接 PATCH 他人回复 / 评论正文被拒', async () => {
    expect((await act('mia', `update forum_replies set body = 'x-mod' where id = $1`, [R.bob])).ok).toBe(
      false,
    );
    expect((await act('mia', `update comments set body = 'x-mod' where id = $1`, [C.bob])).ok).toBe(false);
  });
  it('合法审核仍可用：版主可改他人 published / pinned / locked / featured', async () => {
    const id = await mk('thread');
    for (const col of ['pinned', 'locked', 'featured'])
      expect((await act('mia', `update forum_threads set ${col} = true where id = $1`, [id])).ok, col).toBe(
        true,
      );
    expect((await act('mia', `update forum_threads set published = false where id = $1`, [id])).ok).toBe(
      true,
    );
  });
  it('作者改自己的内容照常；管理员直接 PATCH 他人正文也被拒（必须走带理由的 RPC）', async () => {
    expect(
      (await act('alice', `update forum_threads set body = 'alice 自己改' where id = $1`, [T.alice])).ok,
    ).toBe(true);
    expect((await act('ada', `update forum_threads set body = 'ada 直接改' where id = $1`, [T.bob])).ok).toBe(
      false,
    );
  });
  it('mod_edit_content：管理员带理由可改，写版本 + 审计（含理由）+ 通知作者；版主默认不可用', async () => {
    const id = await mk('thread');
    const [{ edited_at }] = await q(`select edited_at from forum_threads where id = $1`, [id]);
    const r = await act(
      'ada',
      `select mod_edit_content('thread', $1, p_title => '管理员修正标题', p_body => '管理员修正正文', p_reason => '去除联系方式', p_expected_edited_at => $2)`,
      [id, edited_at],
    );
    ok(r);
    const [row] = await q(`select title, body from forum_threads where id = $1`, [id]);
    expect(row).toMatchObject({ title: '管理员修正标题', body: '管理员修正正文' });
    expect(
      Number((await q(`select count(*) from content_versions where target_id = $1`, [id]))[0].count),
    ).toBe(1);
    const [au] = await q(`select detail from audit_log where action = 'content.edit' and target_id = $1`, [
      id,
    ]);
    expect(au.detail.reason).toBe('去除联系方式');
    expect(JSON.stringify(au.detail)).not.toContain('管理员修正正文');
    const [nt] = await q(
      `select count(*) from notifications where user_id = $1 and target_id = $2 and kind = 'moderation'`,
      [U.bob, id],
    );
    expect(Number(nt.count)).toBe(1);
    const m = await act(
      'mia',
      `select mod_edit_content('thread', $1, p_body => 'm', p_reason => '版主试改')`,
      [id],
    );
    expect(!m.ok && m.code).toBe('42501');
    const noReason = await act(
      'ada',
      `select mod_edit_content('thread', $1, p_body => 'm', p_reason => '')`,
      [id],
    );
    expect(noReason.ok).toBe(false);
  });
});

describe('A04 / T067 / T068 封禁旧会话、降权与最后管理员', () => {
  it('已封禁账号沿用旧 JWT 仍不能发帖 / 改帖', async () => {
    const ins = await act(
      'carol',
      `insert into forum_threads (cat, title, body, author) values ('技术', 'x', 'y', $1)`,
      [U.carol],
    );
    expect(ins.ok).toBe(false);
    const up = await act('carol', `update forum_threads set body = 'z' where id = $1`, [T.carol]);
    expect(up.ok && up.rowCount > 0).toBe(false);
  });
  it('降权后下一个请求即失去后台 RPC 权限；恢复后可用', async () => {
    await q(`update profiles set role = 'user' where id = $1`, [U.mia]);
    try {
      const r = await act('mia', `select * from mod_list_content('thread')`);
      expect(!r.ok && r.code).toBe('42501');
    } finally {
      await q(`update profiles set role = 'moderator' where id = $1`, [U.mia]);
    }
    expect((await act('mia', `select * from mod_list_content('thread')`)).ok).toBe(true);
  });
  it('最后一个管理员不能把自己降级或封禁', async () => {
    const r = await act('ada', `select admin_set_user($1, 'user', false)`, [U.ada]);
    expect(r.ok).toBe(false);
    const [p] = await q(`select role from profiles where id = $1`, [U.ada]);
    expect(p.role).toBe('admin');
  });
});

// ------------------------------------------------------------------ A05 ----
describe('A05 / T036 备注与标签增删审计', () => {
  it('版主增删备注 / 标签留最小审计（不复制备注全文）；普通用户被拒且无审计', async () => {
    const before = Number(
      (await q(`select count(*) from audit_log where action like 'note.%' or action like 'tag.%'`))[0].count,
    );
    const n = ok(
      await act(
        'mia',
        `insert into admin_notes (target_type, target_id, body) values ('profile', $1, '敏感备注全文') returning id`,
        [U.bob],
      ),
    );
    const noteId = String(n[0].id);
    ok(await act('mia', `delete from admin_notes where id = $1`, [noteId]));
    ok(await act('mia', `insert into admin_user_tags (user_id, tag) values ($1, 'VIP')`, [U.bob]));
    ok(await act('mia', `delete from admin_user_tags where user_id = $1 and tag = 'VIP'`, [U.bob]));
    const rows = await q(
      `select actor, action, target_type, target_id, detail from audit_log where action like 'note.%' or action like 'tag.%' order by id`,
    );
    expect(rows.length - before).toBe(4);
    const last4 = rows.slice(-4);
    expect(last4.map((r) => r.action)).toEqual(['note.add', 'note.delete', 'tag.add', 'tag.remove']);
    for (const r of last4) expect(r.actor).toBe(U.mia);
    expect(last4[0].detail.note_id).toBe(Number(noteId));
    expect(JSON.stringify(last4)).not.toContain('敏感备注全文');
    // 普通用户 / 伪造 author
    const bad = await act(
      'alice',
      `insert into admin_notes (target_type, target_id, body) values ('profile', $1, 'x')`,
      [U.bob],
    );
    expect(bad.ok).toBe(false);
    const forge = await act(
      'mia',
      `insert into admin_notes (target_type, target_id, body, author) values ('profile', $1, 'x', $2)`,
      [U.bob, U.ada],
    );
    expect(forge.ok).toBe(false);
    const after = Number(
      (await q(`select count(*) from audit_log where action like 'note.%' or action like 'tag.%'`))[0].count,
    );
    expect(after - before).toBe(4);
  });
  it('事务回滚不留假成功审计；版主读不到审计日志', async () => {
    const before = Number((await q(`select count(*) from audit_log where action = 'note.add'`))[0].count);
    const r = await run(
      db.pool,
      as('mia'),
      `insert into admin_notes (target_type, target_id, body) values ('profile', $1, 'rb')`,
      [U.bob],
    ); // run() 默认回滚
    expect(r.ok).toBe(true);
    expect(Number((await q(`select count(*) from audit_log where action = 'note.add'`))[0].count)).toBe(
      before,
    );
    const read = await act('mia', `select * from audit_log where action like 'note.%'`);
    expect(read.ok && read.rowCount).toBe(0);
  });
});

// ------------------------------------------------------------------ A07 ----
describe('A07 / T038 / T066 编辑与工作流并发冲突', () => {
  it('A/B 读同一版本：A 保存成功，B 用旧版本提交被拒（PT409），不覆盖 A；重载后可保存', async () => {
    const id = await mk('thread');
    const [{ edited_at: e0 }] = await q(`select edited_at from forum_threads where id = $1`, [id]);
    ok(
      await act(
        'ada',
        `select mod_edit_content('thread', $1, p_body => 'A 的版本', p_reason => 'A 修改', p_expected_edited_at => $2)`,
        [id, e0],
      ),
    );
    const b = await act(
      'ada',
      `select mod_edit_content('thread', $1, p_body => 'B 的旧版本', p_reason => 'B 修改', p_expected_edited_at => $2)`,
      [id, e0],
    );
    expect(!b.ok && b.code).toBe('PT409');
    expect((await q(`select body from forum_threads where id = $1`, [id]))[0].body).toBe('A 的版本');
    expect(
      Number((await q(`select count(*) from content_versions where target_id = $1`, [id]))[0].count),
    ).toBe(1);
    expect(await auditCount('content.edit', id)).toBe(1);
    const [{ edited_at: e1 }] = await q(`select edited_at from forum_threads where id = $1`, [id]);
    ok(
      await act(
        'ada',
        `select mod_edit_content('thread', $1, p_body => 'B 合并后', p_reason => 'B 修改', p_expected_edited_at => $2)`,
        [id, e1],
      ),
    );
  });
  it('工作流：带过期 updated_at 的变更返回 conflict，不改状态', async () => {
    const id = await mk('reply');
    ok(await act('mia', `select mod_set_workflow('reply', array[$1]::uuid[], 'draft')`, [id]));
    const [{ updated_at: u0 }] = await q(`select updated_at from content_workflow where target_id = $1`, [
      id,
    ]);
    ok(await act('ada', `select mod_set_workflow('reply', array[$1]::uuid[], 'review')`, [id]));
    const r = ok(
      await act(
        'mia',
        `select mod_workflow_apply('reply', array[$1]::uuid[], 'published', null, jsonb_build_object($1::text, $2::text)) as r`,
        [id, new Date(u0).toISOString()],
      ),
    );
    expect(r[0].r.results[0].result).toBe('conflict');
    expect((await state('reply', id)).wf.status).toBe('review');
  });
  it('T066 连续编辑 55 次：保留最近 50 个版本，倒序、编辑者正确', async () => {
    const id = await mk('comment');
    for (let i = 0; i < 55; i++) {
      const [{ edited_at }] = await q(`select edited_at from comments where id = $1`, [id]);
      ok(
        await act(
          'ada',
          `select mod_edit_content('comment', $1, p_body => $2, p_reason => '修订', p_expected_edited_at => $3)`,
          [id, `v${i}`, edited_at],
        ),
      );
    }
    const v = await q(
      `select body, editor from content_versions where target_id = $1 order by created_at desc, id desc`,
      [id],
    );
    expect(v.length).toBe(50);
    expect(v[0].body).toBe('v53');
    expect(v.every((x) => x.editor === U.ada)).toBe(true);
  });
});

// ------------------------------------------------------------------ A08 ----
describe('A08 / T039 / T065 批量逐项结果、去重、上限与幂等重试', () => {
  const missing = '10000000-0000-4000-b000-0000000009ff';
  it('有效 + 重复 + 不存在混合：逐项结果与计数准确', async () => {
    const a = await mk('thread');
    const b = await mk('thread');
    const r = ok(
      await act('mia', `select mod_workflow_apply('thread', $1::uuid[], 'review') as r`, [
        [a, a, missing, b],
      ]),
    )[0].r;
    expect(r).toMatchObject({ requested: 4, unique: 3, duplicates: 1, ok: 2 });
    const by = Object.fromEntries(r.results.map((x: { id: string; result: string }) => [x.id, x.result]));
    expect(by).toEqual({ [a]: 'ok', [b]: 'ok', [missing]: 'not_found' });
    expect(await auditCount('content.workflow', a)).toBe(1);
  });
  it('同一幂等键重试：返回第一次的结果（replayed），无重复副作用', async () => {
    const a = await mk('comment');
    const k = `k-${Date.now()}`;
    const r1 = ok(
      await act('mia', `select mod_set_visibility('comment', $1::uuid[], false, $2) as r`, [[a], k]),
    )[0].r;
    const r2 = ok(
      await act('mia', `select mod_set_visibility('comment', $1::uuid[], false, $2) as r`, [[a], k]),
    )[0].r;
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(r2.results).toEqual(r1.results);
    expect(await auditCount('content.visibility', a)).toBe(1);
  });
  it('上限：0 条 → 空结果；200 条唯一 → 接受；201 条唯一 → 整体拒绝且无任何写入', async () => {
    const z = ok(await act('mia', `select mod_workflow_apply('thread', '{}'::uuid[], 'draft') as r`))[0].r;
    expect(z).toMatchObject({ requested: 0, ok: 0 });
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `20000000-0000-4000-b000-${String(i).padStart(12, '0')}`);
    const r200 = ok(
      await act('mia', `select mod_workflow_apply('thread', $1::uuid[], 'draft') as r`, [ids(200)]),
    )[0].r;
    expect(r200).toMatchObject({ unique: 200, ok: 0 });
    const real = await mk('thread');
    const r201 = await act('mia', `select mod_workflow_apply('thread', $1::uuid[], 'draft')`, [
      [...ids(200), real],
    ]);
    expect(!r201.ok && r201.code).toBe('22023');
    expect((await state('thread', real)).wf).toBeUndefined();
    // 重复 ID 不占上限：同一 id × 300 只算 1 条
    const dup = ok(
      await act('mia', `select mod_workflow_apply('thread', $1::uuid[], 'draft') as r`, [
        Array(300).fill(real),
      ]),
    )[0].r;
    expect(dup).toMatchObject({ unique: 1, duplicates: 299, ok: 1 });
  });
  it('无权限：普通用户调用整体 42501', async () => {
    const r = await act('alice', `select mod_workflow_apply('thread', array[$1]::uuid[], 'draft')`, [T.bob]);
    expect(!r.ok && r.code).toBe('42501');
  });
});

// ------------------------------------------------------------------ A09 ----
describe('A09 / T040 / T070 越界分页与稳定排序', () => {
  it('内容：offset = total / > total 时仍返回真实 total 与最后有效页', async () => {
    const [{ total }] = ok(
      await act('mia', `select (mod_list_content_page('thread', p_limit => 2)) ->> 'total' as total`),
    );
    const t = Number(total);
    expect(t).toBeGreaterThan(2);
    for (const off of [t, t + 50]) {
      const [{ p }] = ok(
        await act('mia', `select mod_list_content_page('thread', p_limit => 2, p_offset => $1) as p`, [off]),
      );
      expect(p.items).toEqual([]);
      expect(p.total).toBe(t);
      expect(p.out_of_range).toBe(true);
      expect(p.last_offset).toBe(Math.floor((t - 1) / 2) * 2);
    }
    // 筛选为空 ≠ 越界
    const [{ p: e }] = ok(
      await act('mia', `select mod_list_content_page('thread', p_q => 'zz-无此词-zz') as p`),
    );
    expect(e).toMatchObject({ total: 0, out_of_range: false, items: [] });
  });
  it('用户：越界页 total 不变 0', async () => {
    const [{ p }] = ok(await act('ada', `select mod_list_users_page(p_limit => 2, p_offset => 1000) as p`));
    expect(p.items).toEqual([]);
    expect(p.total).toBeGreaterThanOrEqual(5);
    expect(p.out_of_range).toBe(true);
  });
  it('并发删除末页后：旧页码越界时仍报告真实 total（不误报数据库为空）', async () => {
    const [{ p: p0 }] = ok(await act('mia', `select mod_list_content_page('comment', p_limit => 2) as p`));
    const last = Math.floor((p0.total - 1) / 2) * 2;
    const lastIds = ok(
      await act('mia', `select id from mod_list_content('comment', p_limit => 2, p_offset => $1)`, [last]),
    ).map((r) => r.id);
    await q(`delete from comments where id = any($1::uuid[])`, [lastIds]);
    const [{ p }] = ok(
      await act('mia', `select mod_list_content_page('comment', p_limit => 2, p_offset => $1) as p`, [last]),
    );
    if (p.items.length === 0) {
      expect(p.total).toBe(p0.total - lastIds.length);
      expect(p.out_of_range).toBe(true);
    }
  });
  it('T070 同 created_at / 同标题：按标题分页无重复无遗漏', async () => {
    await q(
      `insert into forum_threads (cat, title, body, author, created_at)
       select '技术', '同名主题', 'x', $1, '2026-01-01T00:00:00Z' from generate_series(1, 7)`,
      [U.bob],
    );
    const [{ p: first }] = ok(
      await act('mia', `select mod_list_content_page('thread', p_q => '同名主题', p_limit => 3) as p`),
    );
    const seen: string[] = [];
    for (let off = 0; off < first.total; off += 3) {
      const [{ p }] = ok(
        await act(
          'mia',
          `select mod_list_content_page('thread', p_q => '同名主题', p_sort => 'title', p_dir => 'asc', p_limit => 3, p_offset => $1) as p`,
          [off],
        ),
      );
      seen.push(...p.items.map((x: { id: string }) => x.id));
    }
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });
});

// ------------------------------------------------------------------ I04 ----
describe('I04 / T049 服务端授权边界复核', () => {
  it('public 下所有 SECURITY DEFINER 函数都固定了 search_path', async () => {
    const rows = await q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });
  it('anon 对任何 mod_* / admin_* 函数都没有 EXECUTE', async () => {
    const fns = await q(`
      select p.oid::regprocedure::text as sig, p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'mod\\_%' or p.proname like 'admin\\_%')`);
    expect(fns.length).toBeGreaterThan(10);
    const anonExec = await q(
      `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'mod\\_%' or p.proname like 'admin\\_%')
          and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(anonExec.map((r) => r.sig)).toEqual([]);
  });
  it('IDOR：普通用户不能改 / 删别人的主题、回复、评论，也读不到别人的通知', async () => {
    expect(changed(await act('alice', `update forum_threads set body = 'x' where id = $1`, [T.bob]))).toBe(0);
    expect(changed(await act('alice', `delete from forum_replies where id = $1`, [R.bob]))).toBe(0);
    expect(changed(await act('alice', `update comments set body = 'x' where id = $1`, [C.bob]))).toBe(0);
    const n = await act('alice', `select * from notifications where user_id = $1`, [U.bob]);
    expect(n.ok && n.rowCount).toBe(0);
  });
});
