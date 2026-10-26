/**
 * 审计问题回归测试 + 新功能行为（锁定 / 编辑时间 / 通知 / 审计 / 限流 / 外键 / 结构约定）。
 * 审计编号对应 docs/PLAN.md P2 与 PR #2 说明：
 *  (1) 作者改 pinned / 公告 / 伪造 created_at、published
 *  (2) 回复 thread_id 无外键；锁定 / 未发布主题禁止回复
 *  (3) 无限流
 *  (4) 无 updated_at / edited / locked / moderator
 *  (5) anon / authenticated 持有 TRUNCATE / TRIGGER / REFERENCES
 *  (6) 策略里 auth.uid() / is_admin() 未包 (select …)
 *  (7) 新外键缺索引
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, runSeq } from './helpers';
import { C, R, REP, T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('regression');
}, 60_000);
afterAll(async () => db?.close());

const as = (who: keyof typeof U) => ({ role: 'authenticated' as const, uid: U[who] });
const anon = { role: 'anon' as const };
const su = { role: 'superuser' as const };

describe('(1) 作者不能越权改列', () => {
  it('作者 UPDATE pinned → 42501', async () => {
    const r = await run(db.pool, as('alice'), `update forum_threads set pinned = true where id = $1`, [
      T.alice,
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('42501');
  });
  it('作者 UPDATE cat = 公告 → 42501', async () => {
    const r = await run(db.pool, as('alice'), `update forum_threads set cat = '公告' where id = $1`, [
      T.alice,
    ]);
    expect(!r.ok && r.code).toBe('42501');
  });
  it('INSERT 伪造 created_at → 列权限拒绝', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_threads (cat,title,body,author,created_at) values ('产品讨论','t','b',$1,'2000-01-01')`,
      [U.alice],
    );
    expect(!r.ok && r.code).toBe('42501');
  });
  it('INSERT published = false（伪造草稿）→ 42501', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_threads (cat,title,body,author,published) values ('产品讨论','t','b',$1,false)`,
      [U.alice],
    );
    expect(!r.ok && r.code).toBe('42501');
  });
  it('作者不能取消版主的隐藏', async () => {
    await db.pool.query(`update forum_threads set published = false where id = $1`, [T.alice]);
    const r = await run(db.pool, as('alice'), `update forum_threads set published = true where id = $1`, [
      T.alice,
    ]);
    expect(!r.ok && r.code).toBe('42501');
    await db.pool.query(`update forum_threads set published = true where id = $1`, [T.alice]);
  });
  it('版主可以置顶 / 锁定 / 精华，并写入审计日志', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `update forum_threads set pinned = true, locked = true, featured = true where id = $1`,
      [T.alice],
    );
    expect(r.ok && r.rowCount).toBe(1);
    // 提交一次再查审计（run 默认回滚）
    await run(db.pool, as('mia'), `update forum_threads set featured = true where id = $1`, [T.alice], {
      commit: true,
    });
    const a = await db.pool.query(
      `select action, actor, detail from audit_log where target_id = $1 order by id desc limit 1`,
      [T.alice],
    );
    expect(a.rows[0]).toMatchObject({ action: 'thread.update', actor: U.mia });
    expect(a.rows[0].detail.changes.featured).toEqual({ from: false, to: true });
    await db.pool.query(`update forum_threads set featured = false where id = $1`, [T.alice]);
  });
  it('API 写入时 created_at 总是 now()（默认值也不能被绕过）', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_threads (cat,title,body,author) values ('产品讨论','t','b',$1) returning created_at > now() - interval '1 minute' as fresh`,
      [U.alice],
    );
    expect(r.ok && r.rows[0].fresh).toBe(true);
  });
  it('普通用户直接 UPDATE role → 拒绝；admin 也必须走 admin_set_user()', async () => {
    for (const w of ['alice', 'ada'] as const) {
      const r = await run(db.pool, as(w), `update profiles set role = 'admin' where id = $1`, [U[w]]);
      expect(!r.ok && r.code).toBe('42501');
    }
  });
  it('admin_set_user 不能降级 / 封禁自己；支持 moderator；写审计与通知', async () => {
    const self = await run(db.pool, as('ada'), `select admin_set_user($1, 'user', false)`, [U.ada]);
    expect(!self.ok && self.code).toBe('42501');
    const bad = await run(db.pool, as('ada'), `select admin_set_user($1, 'owner', false)`, [U.bob]);
    expect(bad.ok).toBe(false);
    const ok = await run(db.pool, as('ada'), `select admin_set_user($1, 'moderator', false)`, [U.bob], {
      commit: true,
    });
    expect(ok.ok).toBe(true);
    const p = await db.pool.query(`select role from profiles where id = $1`, [U.bob]);
    expect(p.rows[0].role).toBe('moderator');
    const a = await db.pool.query(
      `select action from audit_log where target_id = $1 order by id desc limit 1`,
      [U.bob],
    );
    expect(a.rows[0].action).toBe('user.set_role');
    const n = await db.pool.query(
      `select kind from notifications where user_id = $1 order by id desc limit 1`,
      [U.bob],
    );
    expect(n.rows[0].kind).toBe('moderation');
    await db.pool.query(`update profiles set role = 'user' where id = $1`, [U.bob]);
  });
});

describe('(2) 回复外键与可回复性', () => {
  it('V72 写法（thread_id 文本）自动挂上 thread 外键', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2) returning thread, seed_key`,
      [T.bob, U.alice],
    );
    expect(r.ok && r.rows[0]).toEqual({ thread: T.bob, seed_key: null });
  });
  it('v2 写法（thread uuid）同步 thread_id', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_replies (thread, body) values ($1, 'r') returning thread_id, author`,
      [T.bob],
    );
    expect(r.ok && r.rows[0]).toEqual({ thread_id: T.bob, author: U.alice });
  });
  it('种子主题回复挂到 seed_key', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into forum_replies (thread_id, body, author) values ('t-fm-timeline', 'r', $1) returning thread, seed_key`,
      [U.alice],
    );
    expect(r.ok && r.rows[0]).toEqual({ thread: null, seed_key: 't-fm-timeline' });
  });
  it('不存在的主题 → 23503', async () => {
    for (const tid of ['00000000-0000-4000-8000-000000000000', 't-nope']) {
      const r = await run(
        db.pool,
        as('alice'),
        `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`,
        [tid, U.alice],
      );
      expect(!r.ok && r.code).toBe('23503');
    }
  });
  it('锁定 / 未发布主题 → 42501；版主可以', async () => {
    for (const tid of [T.bobLocked, T.bobHidden, 't-feedback']) {
      const r = await run(
        db.pool,
        as('alice'),
        `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`,
        [tid, U.alice],
      );
      expect(!r.ok && r.code, tid).toBe('42501');
      const m = await run(
        db.pool,
        as('mia'),
        `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`,
        [tid, U.mia],
      );
      expect(m.ok, tid).toBe(true);
    }
  });
  it('锁定后作者不能编辑主题与回复', async () => {
    const t = await run(db.pool, as('bob'), `update forum_threads set title = 'x' where id = $1`, [
      T.bobLocked,
    ]);
    expect(!t.ok && t.code).toBe('42501');
    const r = await run(db.pool, as('bob'), `update forum_replies set body = 'x' where id = $1`, [R.bob], {
      before: [
        `reset role`,
        `update forum_threads set locked = true where id = '${T.bob}'`,
        `set local role authenticated`,
      ],
    });
    expect(!r.ok && r.code).toBe('42501');
  });
  it('删除主题级联删除回复（V72 会留下孤儿）', async () => {
    const seq = await runSeq(db.pool, as('mia'), [
      [`delete from forum_threads where id = $1`, [T.bob]],
      [`select count(*)::int n from forum_replies where thread = $1`, [T.bob]],
    ]);
    expect(seq[0].ok && seq[0].rowCount).toBe(1);
    expect(seq[1].ok && seq[1].rows[0].n).toBe(0);
  });
  it('所有回复恰好挂在一个目标上（约束已 VALID）', async () => {
    const r = await db.pool.query(
      `select convalidated from pg_constraint where conname = 'forum_replies_target_check'`,
    );
    expect(r.rows[0].convalidated).toBe(true);
  });
});

describe('(3) 限流', () => {
  it('发主题：10 分钟内第 4 个 → PT429；版主豁免', async () => {
    const ins: [string, unknown[]] = [
      `insert into forum_threads (cat,title,body,author) values ('产品讨论','t','b',$1)`,
      [U.alice],
    ];
    const out = await runSeq(db.pool, as('alice'), [ins, ins, ins, ins]);
    expect(out.map((o) => o.ok)).toEqual([true, true, true, false]);
    expect(!out[3].ok && out[3].code).toBe('PT429');
    const modIns: [string, unknown[]] = [ins[0], [U.mia]];
    const m = await runSeq(db.pool, as('mia'), Array(6).fill(modIns));
    expect(m.every((o) => o.ok)).toBe(true);
  });
  it('回帖：1 分钟内第 7 条 → PT429', async () => {
    const ins: [string, unknown[]] = [
      `insert into forum_replies (thread_id, body, author) values ($1,'r',$2)`,
      [T.alice, U.bob],
    ];
    const out = await runSeq(db.pool, as('bob'), Array(7).fill(ins));
    expect(out.slice(0, 6).every((o) => o.ok)).toBe(true);
    expect(!out[6].ok && out[6].code).toBe('PT429');
  });
  it('评论：1 分钟内第 6 条 → PT429', async () => {
    const ins: [string, unknown[]] = [
      `insert into comments (page_key, body, author) values ('article:x','c',$1)`,
      [U.alice],
    ];
    const out = await runSeq(db.pool, as('alice'), Array(6).fill(ins));
    expect(!out[5].ok && out[5].code).toBe('PT429');
  });
  it('限流计数表对 API 角色不可见、不可改', async () => {
    for (const who of [anon, as('alice'), as('ada')]) {
      const r = await run(db.pool, who, `select count(*) from rate_limit_events`);
      expect(r.ok).toBe(false);
    }
  });
  it('普通用户不能直接调用 az_rate_limit()', async () => {
    const r = await run(db.pool, as('alice'), `select az_rate_limit('x', 1, interval '1 second')`);
    expect(!r.ok && r.code).toBe('42501');
  });
});

describe('(4) 状态列与通知', () => {
  it('编辑正文写入 edited_at，updated_at 前进', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `update forum_threads set body = 'new' where id = $1 returning edited_at is not null as edited, updated_at >= created_at as moved`,
      [T.alice],
    );
    expect(r.ok && r.rows[0]).toEqual({ edited: true, moved: true });
    const c = await run(
      db.pool,
      as('alice'),
      `update comments set body = 'new' where id = $1 returning edited_at is not null as edited`,
      [C.alice],
    );
    expect(c.ok && c.rows[0].edited).toBe(true);
  });
  it('只改置顶不算编辑（edited_at 不变）', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `update forum_threads set pinned = true where id = $1 returning edited_at`,
      [T.alice],
    );
    expect(r.ok && r.rows[0].edited_at).toBeNull();
  });
  it('回复别人的主题 → 主题作者收到 reply 通知；回复自己的不通知', async () => {
    const seq = await runSeq(db.pool, as('bob'), [
      [
        `insert into forum_replies (thread_id, body, author) values ($1, 'hello alice', $2)`,
        [T.alice, U.bob],
      ],
      [`insert into forum_replies (thread_id, body, author) values ($1, 'self', $2)`, [T.bob, U.bob]],
      [`reset role`],
      [`select user_id, kind, excerpt from notifications where actor = $1 order by id desc`, [U.bob]],
    ]);
    expect(seq[3].ok && seq[3].rows).toEqual([{ user_id: U.alice, kind: 'reply', excerpt: 'hello alice' }]);
  });
  it('版主隐藏内容 → 作者收到 moderation 通知', async () => {
    const seq = await runSeq(db.pool, as('mia'), [
      [`update comments set published = false where id = $1`, [C.alice]],
      [`reset role`],
      [`select kind from notifications where user_id = $1 and kind = 'moderation'`, [U.alice]],
    ]);
    expect(seq[2].ok && seq[2].rows.length).toBe(1);
  });
  it('处理举报 → 举报人收到通知，resolved_by / resolved_at 自动填写', async () => {
    const seq = await runSeq(db.pool, as('mia'), [
      [
        `update reports set status = 'resolved', resolution_note = '已删除' where id = $1 returning resolved_by, resolved_at is not null as at`,
        [REP.alice],
      ],
      [`reset role`],
      [`select kind from notifications where user_id = $1 and kind = 'report'`, [U.alice]],
    ]);
    expect(seq[0].ok && seq[0].rows[0]).toEqual({ resolved_by: U.mia, at: true });
    expect(seq[2].ok && seq[2].rows.length).toBe(1);
  });
  it('举报人不能伪造处理结果', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into reports (reporter, target_type, target_id, reason) values ($1,'reply',$2,'spam') returning status, resolved_by`,
      [U.alice, R.bob],
    );
    expect(r.ok && r.rows[0]).toEqual({ status: 'open', resolved_by: null });
  });
  it('同一目标不能重复举报（未处理时）', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into reports (reporter, target_type, target_id, reason) values ($1,'thread',$2,'spam')`,
      [U.alice, T.bob],
    );
    expect(!r.ok && r.code).toBe('23505');
  });
  it('like_summary / unread_notification_count / mark_notifications_read', async () => {
    const s = await run(db.pool, as('alice'), `select * from like_summary('thread', array[$1::uuid])`, [
      T.bob,
    ]);
    expect(s.ok && s.rows[0]).toMatchObject({ target_id: T.bob, likes: '5', liked: true });
    const seq = await runSeq(db.pool, as('alice'), [
      [`select unread_notification_count() n`],
      [`select mark_notifications_read() n`],
      [`select unread_notification_count() n`],
    ]);
    expect(seq.map((o) => o.ok && o.rows[0].n)).toEqual([1, 1, 0]);
  });
  it('点赞不存在 / 未发布的目标 → 23503', async () => {
    const r = await run(
      db.pool,
      as('alice'),
      `insert into likes (user_id, target_type, target_id) values ($1, 'thread', $2)`,
      [U.alice, T.bobHidden],
    );
    expect(!r.ok && r.code).toBe('23503');
  });
});

describe('注册触发器 handle_new_user', () => {
  it('邮箱前缀 > 40 字也能注册（截断到 40）', async () => {
    const seq = await runSeq(db.pool, su, [
      [
        `insert into auth.users (id, email) values ('20000000-0000-4000-8000-000000000001', $1)`,
        ['y'.repeat(60) + '@ex.com'],
      ],
      [`select char_length(display_name) n from profiles where id = '20000000-0000-4000-8000-000000000001'`],
    ]);
    expect(seq[1].ok && seq[1].rows[0].n).toBe(40);
  });
  it('OAuth 元数据 full_name / user_name 作为昵称', async () => {
    const seq = await runSeq(db.pool, su, [
      [
        `insert into auth.users (id, email, raw_user_meta_data) values ('20000000-0000-4000-8000-000000000002', 'g@x.io', '{"full_name":"Gina Lee"}')`,
      ],
      [
        `insert into auth.users (id, email, raw_user_meta_data) values ('20000000-0000-4000-8000-000000000003', 'h@x.io', '{"user_name":"octocat"}')`,
      ],
      [
        `select display_name from profiles where id in ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003') order by id`,
      ],
    ]);
    expect(seq[2].ok && seq[2].rows.map((r) => r.display_name)).toEqual(['Gina Lee', 'octocat']);
  });
});

describe('(5)(6)(7) 结构约定', () => {
  it('(5) anon / authenticated 在 public 任何表上都没有 TRUNCATE / TRIGGER / REFERENCES', async () => {
    const r = await db.pool.query(`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated')
        and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES')`);
    expect(r.rows).toEqual([]);
  });
  it('(5) anon 在 public 任何表上都没有写权限', async () => {
    const r = await db.pool.query(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon' and privilege_type <> 'SELECT'
      union all
      select table_name, privilege_type from information_schema.column_privileges
      where table_schema = 'public' and grantee = 'anon' and privilege_type in ('INSERT','UPDATE')`);
    expect(r.rows).toEqual([]);
  });
  it('(5) authenticated 不能写 id / author(更新) / created_at / updated_at / edited_at / role / banned', async () => {
    const r = await db.pool.query(`
      select table_name, column_name, privilege_type from information_schema.column_privileges
      where table_schema = 'public' and grantee = 'authenticated'
        and ((privilege_type in ('INSERT','UPDATE') and column_name in ('id','created_at','updated_at','edited_at','role','banned','resolved_by','resolved_at'))
          or (privilege_type = 'UPDATE' and column_name in ('author','user_id','reporter','thread_id','thread','seed_key','page_key')))`);
    expect(r.rows).toEqual([]);
  });
  it('(6) 所有策略里的 auth.uid() / is_admin() / is_moderator() / can_write() 都包在 (select …) 里', async () => {
    const r = await db.pool.query(
      `select tablename, policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') as expr from pg_policies where schemaname = 'public'`,
    );
    const bad = r.rows.filter((p) =>
      /(?<!SELECT )\b(auth\.uid|is_admin|is_moderator|can_write)\(\)/.test(
        p.expr.replace(/\( SELECT /g, '(SELECT ').replace(/\(SELECT /g, 'SELECT '),
      ),
    );
    expect(bad).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(30);
  });
  it('(7) 每个外键都有以其列开头的索引', async () => {
    const r = await db.pool.query(`
      select c.conrelid::regclass::text as tbl, c.conname
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid
            and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)`);
    expect(r.rows).toEqual([]);
  });
  it('所有 public 表都启用了 RLS', async () => {
    const r = await db.pool.query(
      `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`,
    );
    expect(r.rows).toEqual([]);
  });
  it('SECURITY DEFINER 函数都固定了 search_path', async () => {
    const r = await db.pool.query(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and (proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%'))`,
    );
    expect(r.rows).toEqual([]);
  });
  it('API 角色只能执行白名单里的函数', async () => {
    const r = await db.pool.query(`
      select p.proname, r.rolname from pg_proc p cross join (values ('anon'),('authenticated')) r(rolname)
      where p.pronamespace = 'public'::regnamespace and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
      order by 1, 2`);
    const got = r.rows.map((x) => `${x.proname}:${x.rolname}`);
    expect(got).toEqual([
      'admin_friend_link_delete:authenticated',
      'admin_friend_link_set_status:authenticated',
      'admin_list_friend_links:authenticated',
      'admin_set_user:authenticated',
      'admin_stats:authenticated',
      'admin_subscriber_counts:authenticated',
      'app_count_download:anon',
      'app_count_download:authenticated',
      'az_ugc_image_upload_ok:authenticated',
      'can_write:anon',
      'can_write:authenticated',
      'current_app_role:anon',
      'current_app_role:authenticated',
      'friend_link_submit:anon',
      'friend_link_submit:authenticated',
      'guestbook_submit:anon',
      'guestbook_submit:authenticated',
      'is_admin:anon',
      'is_admin:authenticated',
      'is_moderator:anon',
      'is_moderator:authenticated',
      'like_summary:anon',
      'like_summary:authenticated',
      'mark_notifications_read:authenticated',
      'mod_ban_user:authenticated',
      'mod_guestbook_delete:authenticated',
      'mod_guestbook_set_status:authenticated',
      'mod_handle_reports:authenticated',
      'mod_lift_expired_bans:authenticated',
      'mod_list_content:authenticated',
      'mod_list_users:authenticated',
      'mod_set_workflow:authenticated',
      'mod_unban_user:authenticated',
      'mod_user_profile:authenticated',
      'mod_warn_user:authenticated',
      'mod_workflow_tick:authenticated',
      'search_threads:anon',
      'search_threads:authenticated',
      'subscribe_confirm:anon',
      'subscribe_confirm:authenticated',
      'subscribe_request:anon',
      'subscribe_request:authenticated',
      'subscribe_unsubscribe:anon',
      'subscribe_unsubscribe:authenticated',
      'thread_reply_counts:anon',
      'thread_reply_counts:authenticated',
      'unread_notification_count:authenticated',
    ]);
  });
});
