/**
 * 0009（P4 管理后台）：封禁记录与到期、版主 / 管理员权限边界、举报批量处理、警告、
 * 后台统计与列表 RPC、@提及通知、注册开关、站点设置写权限、审计。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from './helpers';
import { C, R, REP, T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('admin');
}, 60_000);
afterAll(async () => db?.close());

const as = (who: keyof typeof U) => ({ role: 'authenticated' as const, uid: U[who] });
const anon = { role: 'anon' as const };
const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);
const lastAudit = async (target: string) =>
  (await q(`select action, detail, actor from audit_log where target_id = $1 order by id desc`, [target]))
    .rows;
const reset = async (who: keyof typeof U, banned = false) => {
  await q(`update profiles set banned = $2 where id = $1`, [U[who], banned]);
  await q(`delete from user_bans where user_id = $1`, [U[who]]);
};

describe('角色边界', () => {
  it('版主 / 用户不能改角色（admin_set_user 仅管理员）', async () => {
    for (const w of ['mia', 'alice', 'carol'] as const) {
      const r = await run(db.pool, as(w), `select admin_set_user($1, 'admin', false)`, [U.bob]);
      expect(!r.ok && r.code, w).toBe('42501');
    }
    const a = await run(db.pool, anon, `select admin_set_user($1, 'admin', false)`, [U.bob]);
    expect(!a.ok && a.code).toBe('42501');
  });
  it('审计日志：只有管理员可读；版主 0 行，用户 0 行，匿名无权限', async () => {
    const n = async (w: keyof typeof U) => {
      const r = await run(db.pool, as(w), `select count(*)::int n from audit_log`);
      return r.ok ? (r.rows[0].n as number) : -1;
    };
    expect(await n('alice')).toBe(0);
    expect(await n('mia')).toBe(0);
    expect(await n('ada')).toBeGreaterThan(0);
    const r = await run(db.pool, anon, `select count(*) from audit_log`);
    expect(!r.ok && r.code).toBe('42501');
  });
  it('用户读不到别人的举报；版主可以读全部', async () => {
    const mine = await run(db.pool, as('alice'), `select id from reports`);
    expect(mine.ok && mine.rows.map((x) => x.id)).toEqual([REP.alice]);
    const mod = await run(db.pool, as('mia'), `select count(*)::int n from reports`);
    expect(mod.ok && mod.rows[0].n).toBe(2);
  });
  it('后台 RPC：普通用户 / 被封禁用户 → 42501，匿名没有 EXECUTE', async () => {
    const calls = [
      `select admin_stats()`,
      `select * from mod_list_content('thread')`,
      `select * from mod_list_users()`,
      `select mod_lift_expired_bans()`,
      `select mod_ban_user('${U.bob}', 'x')`,
      `select mod_unban_user('${U.carol}')`,
      `select mod_warn_user('${U.bob}', 'x')`,
      `select mod_handle_reports(array['${REP.alice}']::uuid[], 'dismissed')`,
    ];
    for (const sql of calls) {
      for (const w of ['alice', 'carol'] as const) {
        const r = await run(db.pool, as(w), sql);
        expect(!r.ok && r.code, `${w}: ${sql}`).toBe('42501');
      }
      const a = await run(db.pool, anon, sql);
      expect(!a.ok && a.code, `anon: ${sql}`).toBe('42501');
    }
  });
  it('站点设置（site_content kind=setting）：管理员可写，版主 / 用户不可；匿名可读已发布设置', async () => {
    const up = `insert into site_content (kind, slug, data, published) values ('setting', 'announcement', '{"enabled":true,"text":"hi"}', true)
                on conflict (kind, slug) do update set data = excluded.data`;
    for (const w of ['alice', 'mia'] as const) {
      const r = await run(db.pool, as(w), up);
      expect(!r.ok && r.code, w).toBe('42501');
    }
    const ok = await run(db.pool, as('ada'), up, [], { commit: true });
    expect(ok.ok).toBe(true);
    const read = await run(
      db.pool,
      anon,
      `select data from site_content where kind = 'setting' and slug = 'announcement'`,
    );
    expect(read.ok && read.rows[0].data).toEqual({ enabled: true, text: 'hi' });
    expect((await lastAudit('setting:announcement'))[0].action).toBe('content.insert');
  });
});

describe('封禁', () => {
  it('版主封禁普通用户（带原因与到期时间）：不能再发帖，写封禁记录、审计、通知', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `select mod_ban_user($1, '刷屏', now() + interval '1 day')`,
      [U.alice],
      { commit: true },
    );
    expect(r.ok, !r.ok ? r.message : '').toBe(true);
    expect((await q(`select banned from profiles where id = $1`, [U.alice])).rows[0].banned).toBe(true);
    const b = (
      await q(`select reason, expires_at, created_by, lifted_at from user_bans where user_id = $1`, [U.alice])
    ).rows;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ reason: '刷屏', created_by: U.mia, lifted_at: null });
    const a = await lastAudit(U.alice);
    expect(a[0].action).toBe('user.ban');
    expect(a[0].actor).toBe(U.mia);
    const n = await q(`select kind, excerpt from notifications where user_id = $1 order by id desc limit 1`, [
      U.alice,
    ]);
    expect(n.rows[0].kind).toBe('moderation');
    expect(n.rows[0].excerpt).toMatch(/限制发言.*原因：刷屏/);
    const post = await run(
      db.pool,
      as('alice'),
      `insert into forum_threads (cat, title, body, author) values ('技术交流', 't', 'b', $1)`,
      [U.alice],
    );
    expect(!post.ok && post.code).toBe('42501');
    // 自己能读到自己的封禁记录；别人读不到；版主可以
    const own = await run(db.pool, as('alice'), `select reason from user_bans`);
    expect(own.ok && own.rows).toEqual([{ reason: '刷屏' }]);
    const other = await run(db.pool, as('bob'), `select count(*)::int n from user_bans where user_id = $1`, [
      U.alice,
    ]);
    expect(other.ok && other.rows[0].n).toBe(0);
    const mod = await run(db.pool, as('mia'), `select count(*)::int n from user_bans where user_id = $1`, [
      U.alice,
    ]);
    expect(mod.ok && mod.rows[0].n).toBe(1);
  });
  it('封禁到期后立即恢复写权限；mod_lift_expired_bans 清标志并记审计', async () => {
    await q(`update user_bans set expires_at = now() - interval '1 minute' where user_id = $1`, [U.alice]);
    const role = await run(db.pool, as('alice'), `select current_app_role() r, can_write() w`);
    expect(role.ok && role.rows[0]).toEqual({ r: 'user', w: true });
    const lifted = await run(db.pool, as('mia'), `select mod_lift_expired_bans() n`, [], { commit: true });
    expect(lifted.ok && lifted.rows[0].n).toBe(1);
    expect((await q(`select banned from profiles where id = $1`, [U.alice])).rows[0].banned).toBe(false);
    const b = (await q(`select lifted_at, lift_reason from user_bans where user_id = $1`, [U.alice])).rows[0];
    expect(b.lifted_at).not.toBeNull();
    expect(b.lift_reason).toBe('到期自动解除');
    expect((await lastAudit(U.alice))[0].action).toBe('user.ban_expired');
    await reset('alice');
  });
  it('不能封禁自己；版主不能封禁版主 / 管理员；管理员可以封禁版主', async () => {
    const self = await run(db.pool, as('mia'), `select mod_ban_user($1, 'x')`, [U.mia]);
    expect(!self.ok && self.code).toBe('42501');
    const adminSelf = await run(db.pool, as('ada'), `select mod_ban_user($1, 'x')`, [U.ada]);
    expect(!adminSelf.ok && adminSelf.code).toBe('42501');
    const modAdmin = await run(db.pool, as('mia'), `select mod_ban_user($1, 'x')`, [U.ada]);
    expect(!modAdmin.ok && modAdmin.code).toBe('42501');
    const adminMod = await run(db.pool, as('ada'), `select mod_ban_user($1, 'x')`, [U.mia]);
    expect(adminMod.ok).toBe(true);
    const past = await run(db.pool, as('mia'), `select mod_ban_user($1, 'x', now() - interval '1 day')`, [
      U.bob,
    ]);
    expect(!past.ok && past.code).toBe('22023');
    const long = await run(db.pool, as('mia'), `select mod_ban_user($1, repeat('x', 501))`, [U.bob]);
    expect(!long.ok && long.code).toBe('22001');
  });
  it('解封：版主解封用户、写 lift_reason 与审计；admin_set_user 解封也会关闭封禁记录', async () => {
    const ban = await run(db.pool, as('mia'), `select mod_ban_user($1, '广告')`, [U.bob], { commit: true });
    expect(ban.ok).toBe(true);
    const un = await run(db.pool, as('mia'), `select mod_unban_user($1, '申诉通过')`, [U.bob], {
      commit: true,
    });
    expect(un.ok).toBe(true);
    const b = (await q(`select lifted_by, lift_reason from user_bans where user_id = $1`, [U.bob])).rows[0];
    expect(b).toEqual({ lifted_by: U.mia, lift_reason: '申诉通过' });
    expect((await lastAudit(U.bob))[0].action).toBe('user.unban');
    // admin_set_user 封禁 → 自动建一条永久封禁记录；解封 → 关闭
    await run(db.pool, as('ada'), `select admin_set_user($1, 'user', true)`, [U.bob], { commit: true });
    expect(
      (await q(`select count(*)::int n from user_bans where user_id = $1 and lifted_at is null`, [U.bob]))
        .rows[0].n,
    ).toBe(1);
    await run(db.pool, as('ada'), `select admin_set_user($1, 'user', false)`, [U.bob], { commit: true });
    expect(
      (await q(`select count(*)::int n from user_bans where user_id = $1 and lifted_at is null`, [U.bob]))
        .rows[0].n,
    ).toBe(0);
    await reset('bob');
  });
  it('直接 UPDATE banned 仍然被拒绝（版主也必须走接口）', async () => {
    const r = await run(db.pool, as('mia'), `update profiles set banned = true where id = $1`, [U.bob]);
    expect(!r.ok && r.code).toBe('42501');
    // 自己设置放行标记也没用：authenticated 对 banned 列没有 UPDATE 权限（只有 SECURITY DEFINER 接口能改）
    const forged = await run(db.pool, as('mia'), `update profiles set banned = true where id = $1`, [U.bob], {
      before: [`select set_config('az.mod_ban', 'on', true)`],
    });
    expect(!forged.ok && forged.code).toBe('42501');
    // 被封禁用户给自己解封：拒绝
    const self = await run(
      db.pool,
      as('carol'),
      `update profiles set banned = false where id = $1`,
      [U.carol],
      {
        before: [`select set_config('az.mod_ban', 'on', true)`],
      },
    );
    expect(!self.ok && self.code).toBe('42501');
    const role = await run(db.pool, as('mia'), `update profiles set role = 'admin' where id = $1`, [U.mia], {
      before: [`select set_config('az.mod_ban', 'on', true)`],
    });
    expect(!role.ok && role.code).toBe('42501');
  });
});

describe('举报处理 mod_handle_reports', () => {
  it('隐藏内容 + resolved：内容隐藏、举报关闭、两条审计、举报人与作者都收到通知', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1, $2]::uuid[], 'resolved', '违规广告', 'hide') n`,
      [REP.alice, REP.bob],
      { commit: true },
    );
    expect(r.ok && r.rows[0].n, !r.ok ? r.message : '').toBe(2);
    expect((await q(`select published from forum_threads where id = $1`, [T.bob])).rows[0].published).toBe(
      false,
    );
    const reps = (
      await q(`select status, resolution_note, resolved_by from reports where id = any($1)`, [
        [REP.alice, REP.bob],
      ])
    ).rows;
    expect(
      reps.every(
        (x) => x.status === 'resolved' && x.resolution_note === '违规广告' && x.resolved_by === U.mia,
      ),
    ).toBe(true);
    const actions = (await lastAudit(T.bob)).map((x) => x.action);
    expect(actions).toContain('report.action.hide');
    expect(actions).toContain('thread.update');
    expect((await lastAudit(REP.alice))[0].action).toBe('report.resolved');
    const toReporter = await q(`select kind from notifications where user_id = $1 and kind = 'report'`, [
      U.alice,
    ]);
    expect(toReporter.rowCount).toBeGreaterThan(0);
    const toAuthor = await q(
      `select excerpt from notifications where user_id = $1 and kind = 'moderation' order by id desc limit 1`,
      [U.bob],
    );
    expect(toAuthor.rows[0].excerpt).toMatch(/隐藏/);
    // 已处理的举报再次处理：0 条
    const again = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1]::uuid[], 'dismissed') n`,
      [REP.alice],
    );
    expect(again.ok && again.rows[0].n).toBe(0);
    await q(`update forum_threads set published = true where id = $1`, [T.bob]);
  });
  it('参数校验：动作必须配 resolved；状态 / 动作取值；一次最多 100 条', async () => {
    const id = (
      await q(
        `insert into reports (reporter, target_type, target_id, reason) values ($1, 'reply', $2, 'spam') returning id`,
        [U.ada, R.alice],
      )
    ).rows[0].id;
    for (const [sql, code] of [
      [`select mod_handle_reports(array['${id}']::uuid[], 'dismissed', '', 'hide')`, '22023'],
      [`select mod_handle_reports(array['${id}']::uuid[], 'open')`, '22023'],
      [`select mod_handle_reports(array['${id}']::uuid[], 'resolved', '', 'nuke')`, '22023'],
      [`select mod_handle_reports('{}'::uuid[], 'resolved')`, '22023'],
      [
        `select mod_handle_reports(array(select gen_random_uuid() from generate_series(1, 101)), 'resolved')`,
        '22023',
      ],
    ] as const) {
      const r = await run(db.pool, as('mia'), sql);
      expect(!r.ok && r.code, sql).toBe(code);
    }
  });
  it('锁定：举报回复 → 锁定所在主题；警告：作者收到「版主提醒」并记审计', async () => {
    const id = (await q(`select id from reports where target_id = $1 and status = 'open'`, [R.alice])).rows[0]
      .id;
    const r = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1]::uuid[], 'resolved', '', 'lock') n`,
      [id],
      {
        commit: true,
      },
    );
    expect(r.ok && r.rows[0].n).toBe(1);
    expect((await q(`select locked from forum_threads where id = $1`, [T.bob])).rows[0].locked).toBe(true);
    await q(`update forum_threads set locked = false where id = $1`, [T.bob]);

    const id2 = (
      await q(
        `insert into reports (reporter, target_type, target_id, reason) values ($1, 'comment', $2, 'abuse') returning id`,
        [U.ada, C.alice],
      )
    ).rows[0].id;
    const w = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1]::uuid[], 'resolved', '注意措辞', 'warn')`,
      [id2],
      {
        commit: true,
      },
    );
    expect(w.ok).toBe(true);
    const n = await q(
      `select excerpt, target_type, target_id from notifications where user_id = $1 order by id desc limit 1`,
      [U.alice],
    );
    expect(n.rows[0]).toEqual({ excerpt: '版主提醒：注意措辞', target_type: 'comment', target_id: C.alice });
    expect((await lastAudit(U.alice))[0].action).toBe('user.warn');
  });
  it('封禁：按天数封禁被举报内容的作者；版主处理指向管理员的举报时封禁被拒绝（整体回滚）', async () => {
    const id = (
      await q(
        `insert into reports (reporter, target_type, target_id, reason) values ($1, 'thread', $2, 'spam') returning id`,
        [U.bob, T.alice],
      )
    ).rows[0].id;
    const r = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1]::uuid[], 'resolved', '广告', 'ban', 7)`,
      [id],
      {
        commit: true,
      },
    );
    expect(r.ok, !r.ok ? r.message : '').toBe(true);
    const b = (
      await q(`select expires_at - created_at as d from user_bans where user_id = $1 and lifted_at is null`, [
        U.alice,
      ])
    ).rows[0];
    expect(b.d.days).toBe(7);
    await reset('alice');

    const id2 = (
      await q(
        `insert into reports (reporter, target_type, target_id, reason) values ($1, 'thread', $2, 'spam') returning id`,
        [U.bob, T.ada],
      )
    ).rows[0].id;
    const deny = await run(
      db.pool,
      as('mia'),
      `select mod_handle_reports(array[$1]::uuid[], 'resolved', '', 'ban')`,
      [id2],
    );
    expect(!deny.ok && deny.code).toBe('42501');
    expect((await q(`select status from reports where id = $1`, [id2])).rows[0].status).toBe('open');
  });
});

describe('后台统计与列表', () => {
  it('admin_stats：计数、近 7/30 天注册、30 天每日序列', async () => {
    const r = await run(db.pool, as('mia'), `select admin_stats() s`);
    expect(r.ok).toBe(true);
    const s = r.ok ? (r.rows[0].s as Record<string, unknown>) : {};
    const users = (await q(`select count(*)::int n from profiles`)).rows[0].n;
    expect(s.users).toBe(users);
    expect(s.signups_7).toBe(users);
    expect(s.threads).toBe((await q(`select count(*)::int n from forum_threads`)).rows[0].n);
    expect(s.reports_open).toBe(
      (await q(`select count(*)::int n from reports where status = 'open'`)).rows[0].n,
    );
    const daily = s.daily as { day: string; signups: number; posts: number }[];
    expect(daily).toHaveLength(30);
    expect(daily.at(-1)!.signups).toBe(users);
    expect(daily.reduce((a, d) => a + d.posts, 0)).toBeGreaterThan(0);
  });
  it('mod_list_content：类型、隐藏、被举报、作者、关键词、分页与总数', async () => {
    const list = async (args: string) => {
      const r = await run(db.pool, as('mia'), `select * from mod_list_content(${args})`);
      if (!r.ok) throw new Error(r.message);
      return r.rows;
    };
    const all = await list(`'thread'`);
    expect(Number(all[0].total)).toBe((await q(`select count(*)::int n from forum_threads`)).rows[0].n);
    const hidden = await list(`'thread', p_hidden => true`);
    expect(hidden.map((x) => x.id)).toEqual([T.bobHidden]);
    const reported = await list(`'thread', p_reported => true`);
    expect(reported.every((x) => x.open_reports > 0)).toBe(true);
    expect(reported.map((x) => x.id)).toContain(T.ada);
    const byAuthor = await list(`'reply', p_author => '${U.bob}'`);
    expect(byAuthor.every((x) => x.author === U.bob && x.kind === 'reply')).toBe(true);
    expect(byAuthor.find((x) => x.id === R.bob)?.title).toBe('bob thread');
    const kw = await list(`'thread', p_q => 'locked'`);
    expect(kw.map((x) => x.id)).toEqual([T.bobLocked]);
    const cat = await list(`'thread', p_cat => '公告'`);
    expect(cat.map((x) => x.id)).toEqual([T.announce]);
    const page = await list(`'comment', p_limit => 2, p_offset => 2`);
    expect(page).toHaveLength(2);
    expect(page[0].page_key).toMatch(/^article:/);
    // LIKE 通配符被转义
    expect(await list(`'thread', p_q => '%'`)).toEqual([]);
  });
  it('mod_list_users：邮箱只对管理员返回；按昵称 / 邮箱搜索、角色、封禁筛选', async () => {
    const asMod = await run(db.pool, as('mia'), `select * from mod_list_users('alice')`);
    expect(asMod.ok && asMod.rows.map((x) => [x.display_name, x.email])).toEqual([['alice', null]]);
    const asAdmin = await run(db.pool, as('ada'), `select * from mod_list_users('alice@example')`);
    expect(asAdmin.ok && asAdmin.rows.map((x) => x.email)).toEqual(['alice@example.com']);
    const modByEmail = await run(db.pool, as('mia'), `select * from mod_list_users('alice@example')`);
    expect(modByEmail.ok && modByEmail.rows).toEqual([]);
    const banned = await run(
      db.pool,
      as('mia'),
      `select display_name, ban_reason from mod_list_users(p_banned => true)`,
    );
    expect(banned.ok && banned.rows.map((x) => x.display_name)).toEqual(['carol']);
    const mods = await run(
      db.pool,
      as('mia'),
      `select display_name from mod_list_users(p_role => 'moderator')`,
    );
    expect(mods.ok && mods.rows.map((x) => x.display_name)).toEqual(['mia']);
    const one = await run(
      db.pool,
      as('mia'),
      `select threads, replies, comments from mod_list_users(p_id => $1)`,
      [U.bob],
    );
    expect(one.ok && one.rows[0]).toMatchObject({ threads: 3 });
  });
});

describe('@提及通知', () => {
  const mentions = async (who: keyof typeof U) =>
    (
      await q(
        `select thread_key, target_type, actor from notifications where user_id = $1 and kind = 'mention' order by id`,
        [U[who]],
      )
    ).rows;
  it('回复里 @昵称（含紧跟中文）→ 被提及者收到 mention；作者自己、邮箱、主题作者（已有 reply 通知）不重复', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_replies (thread_id, body, author) values ($1, '@mia你好，也请 @ada 看看；@alice 与 x@bob.com 不算；@bob 是主题作者', $2) returning id`,
      [T.bob, U.alice],
      { commit: true },
    );
    expect(r.ok, !r.ok ? r.message : '').toBe(true);
    const id = r.ok ? r.rows[0].id : '';
    const name: Record<string, string> = {
      [U.mia]: 'mia',
      [U.ada]: 'ada',
      [U.bob]: 'bob',
      [U.alice]: 'alice',
    };
    const got = (
      await q(`select user_id, kind, thread_key from notifications where target_id = $1`, [id])
    ).rows.map((x) => `${name[x.user_id] ?? 'other'}:${x.kind}`);
    expect(got.sort()).toEqual(['ada:mention', 'bob:reply', 'mia:mention']);
  });
  it('评论里提及 → thread_key 为 page_key；重名昵称不通知；被封禁用户不通知', async () => {
    await q(
      `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), 'm1@x.com', '{"name":"同名"}'), (gen_random_uuid(), 'm2@x.com', '{"name":"同名"}')`,
    );
    await q(
      `insert into comments (page_key, body, author) values ('article:x', '@mia 好文 @同名 @carol', $1)`,
      [U.bob],
    );
    const m = await mentions('mia');
    expect(m.at(-1)).toMatchObject({ thread_key: 'article:x', target_type: 'comment', actor: U.bob });
    expect(
      (
        await q(
          `select count(*)::int n from notifications n join profiles p on p.id = n.user_id where p.display_name = '同名'`,
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await mentions('carol')).toEqual([]);
  });
  it('一条最多通知 5 人；隐藏发布（版主 published=false）不通知', async () => {
    const names = Array.from({ length: 7 }, (_, i) => `提及${i}`);
    for (const n of names)
      await q(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2)`, [
        `${n}@x.com`,
        { name: n },
      ]);
    const body = names.map((n) => `@${n} `).join('');
    await q(`insert into forum_replies (thread_id, body, author) values ($1, $2, $3)`, [
      T.alice,
      body,
      U.bob,
    ]);
    const n = await q(`select count(*)::int n from notifications where kind = 'mention' and excerpt = $1`, [
      body.slice(0, 140),
    ]);
    expect(n.rows[0].n).toBe(5);
    await q(
      `insert into forum_replies (thread_id, body, author, published) values ($1, '@mia 隐藏', $2, false)`,
      [T.alice, U.bob],
    );
    expect((await q(`select count(*)::int n from notifications where excerpt = '@mia 隐藏'`)).rows[0].n).toBe(
      0,
    );
  });
});

describe('注册开关（注册钩子读取站点设置）', () => {
  const hook = async () =>
    (
      await q(
        `select az_hook_before_user_created('{"user":{"email":"a@b.com","app_metadata":{"provider":"github"}}}') r`,
      )
    ).rows[0].r;
  it('registration.open = false → 所有新用户被拒绝；open = true / 未设置 → 放行', async () => {
    expect(await hook()).toEqual({});
    await q(
      `insert into site_content (kind, slug, data) values ('setting', 'registration', '{"open":false}')`,
    );
    expect((await hook()).error.message).toMatch(/关闭/);
    await q(
      `update site_content set data = '{"open":true}' where kind = 'setting' and slug = 'registration'`,
    );
    expect(await hook()).toEqual({});
    await q(`delete from site_content where kind = 'setting' and slug = 'registration'`);
  });
});

describe('迁移可重复执行', () => {
  it('0009 再执行一遍不报错，封禁记录不重复', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { ROOT } = await import('./helpers');
    const before = (await q(`select count(*)::int n from user_bans`)).rows[0].n;
    await q(readFileSync(join(ROOT, 'db/migrations/0009_admin.sql'), 'utf8'));
    expect((await q(`select count(*)::int n from user_bans`)).rows[0].n).toBe(before);
  });
});
