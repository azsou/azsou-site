/**
 * 0017（P10 PR H 后台 CRM）：服务端排序、后台备注、用户标签与画像、内容工作流 + 定时发布、版本历史。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run } from './helpers';
import { T, U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('crm');
}, 60_000);
afterAll(async () => db?.close());

const as = (who: keyof typeof U) => ({ role: 'authenticated' as const, uid: U[who] });
const anon = { role: 'anon' as const };
const q = (sql: string, p: unknown[] = []) => db.pool.query(sql, p);

describe('T10.17 服务端排序', () => {
  it('mod_list_content 按标题升 / 降序；默认仍按时间倒序；非法列拒绝', async () => {
    const asc = await run(
      db.pool,
      as('mia'),
      `select title from mod_list_content('thread', p_sort => 'title', p_dir => 'asc', p_limit => 100)`,
    );
    const desc = await run(
      db.pool,
      as('mia'),
      `select title from mod_list_content('thread', p_sort => 'title', p_dir => 'desc', p_limit => 100)`,
    );
    expect(asc.ok && desc.ok).toBe(true);
    if (!asc.ok || !desc.ok) return;
    const a = asc.rows.map((r) => r.title as string);
    expect(a.length).toBeGreaterThan(2);
    expect([...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))).toEqual(a);
    expect(desc.rows.map((r) => r.title)).toEqual([...a].reverse());
    const def = await run(
      db.pool,
      as('mia'),
      `select created_at from mod_list_content('thread', p_limit => 100)`,
    );
    const ts = def.ok ? def.rows.map((r) => +new Date(r.created_at as string)) : [];
    expect([...ts].sort((x, y) => y - x)).toEqual(ts);
    const bad = await run(
      db.pool,
      as('mia'),
      `select * from mod_list_content('thread', p_sort => 'body; drop')`,
    );
    expect(!bad.ok && bad.code).toBe('22023');
  });
  it('旧调用方式（不带排序参数）照常；新列 wf_status 有值', async () => {
    const r = await run(
      db.pool,
      as('ada'),
      `select wf_status from mod_list_content('comment', null, null, null, null, null, 5, 0)`,
    );
    expect(r.ok && r.rows.every((x) => ['published', 'offline'].includes(x.wf_status as string))).toBe(true);
  });
  it('mod_list_users 按发帖数降序', async () => {
    const r = await run(
      db.pool,
      as('ada'),
      `select threads from mod_list_users(p_sort => 'threads', p_dir => 'desc', p_limit => 100)`,
    );
    const n = r.ok ? r.rows.map((x) => x.threads as number) : [];
    expect(n.length).toBeGreaterThan(2);
    expect([...n].sort((x, y) => y - x)).toEqual(n);
  });
  it('普通用户 / 匿名不能调用', async () => {
    const r = await run(db.pool, as('alice'), `select * from mod_list_users(p_sort => 'role')`);
    expect(!r.ok && r.code).toBe('42501');
    const a = await run(db.pool, anon, `select * from mod_list_content('thread')`);
    expect(!a.ok && a.code).toBe('42501');
  });
});

describe('T10.18 后台备注', () => {
  it('版主可写可读；普通用户读不到也写不了；只能删自己的（管理员可删全部）', async () => {
    const add = await run(
      db.pool,
      as('mia'),
      `insert into admin_notes (target_type, target_id, body) values ('profile', $1, '多次灌水，已口头提醒') returning id`,
      [U.bob],
      { commit: true },
    );
    expect(add.ok).toBe(true);
    const id = add.ok ? add.rows[0].id : 0;
    const read = await run(db.pool, as('ada'), `select body from admin_notes where target_id = $1`, [U.bob]);
    expect(read.ok && read.rows.length).toBe(1);
    const user = await run(db.pool, as('alice'), `select count(*)::int n from admin_notes`);
    expect(!user.ok || user.rows[0].n === 0).toBe(true);
    const userIns = await run(
      db.pool,
      as('alice'),
      `insert into admin_notes (target_type, target_id, body) values ('profile', $1, 'x')`,
      [U.bob],
    );
    expect(userIns.ok).toBe(false);
    const spoof = await run(
      db.pool,
      as('mia'),
      `insert into admin_notes (target_type, target_id, body, author) values ('profile', $1, 'x', $2)`,
      [U.bob, U.ada],
    );
    expect(spoof.ok).toBe(false);
    // 另一位版主身份删不了 mia 的备注：用 ada（管理员）删得掉
    const del = await run(db.pool, as('ada'), `delete from admin_notes where id = $1`, [id]);
    expect(del.ok && del.rowCount).toBe(1);
  });
  it('空备注被拒绝', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `insert into admin_notes (target_type, target_id, body) values ('thread', $1, '   ')`,
      [T.bob],
    );
    expect(!r.ok && r.code).toBe('23514');
  });
});

describe('T10.20 用户标签与画像', () => {
  it('标签：版主可加可删；画像返回帖子 / 举报 / 标签；邮箱订阅只对管理员可见', async () => {
    const t = await run(
      db.pool,
      as('mia'),
      `insert into admin_user_tags (user_id, tag) values ($1, '种子用户')`,
      [U.bob],
      {
        commit: true,
      },
    );
    expect(t.ok).toBe(true);
    const mod = await run(db.pool, as('mia'), `select mod_user_profile($1) p`, [U.bob]);
    const p = mod.ok ? (mod.rows[0].p as Record<string, unknown>) : {};
    expect(p.tags).toEqual(['种子用户']);
    expect((p.posts as unknown[]).length).toBeGreaterThan(0);
    expect(p.subscription_visible).toBe(false);
    expect(Array.isArray(p.logins)).toBe(true);
    const adm = await run(db.pool, as('ada'), `select mod_user_profile($1) p`, [U.bob]);
    expect(adm.ok && (adm.rows[0].p as Record<string, unknown>).subscription_visible).toBe(true);
    const user = await run(db.pool, as('alice'), `select mod_user_profile($1)`, [U.bob]);
    expect(!user.ok && user.code).toBe('42501');
    const none = await run(
      db.pool,
      as('ada'),
      `select mod_user_profile('00000000-0000-4000-a000-0000000000ff') p`,
    );
    expect(none.ok && none.rows[0].p).toBeNull();
  });
});

describe('T10.21 内容工作流 + 定时发布 + 版本', () => {
  it('转为草稿 → 下线（published=false），待审 + 定时 → tick 后发布', async () => {
    const d = await run(
      db.pool,
      as('mia'),
      `select mod_set_workflow('thread', array[$1]::uuid[], 'draft') n`,
      [T.bob],
      {
        commit: true,
      },
    );
    expect(d.ok && d.rows[0].n).toBe(1);
    expect((await q(`select published from forum_threads where id = $1`, [T.bob])).rows[0].published).toBe(
      false,
    );
    const s = await run(
      db.pool,
      as('mia'),
      `select mod_set_workflow('thread', array[$1]::uuid[], 'review', now() - interval '1 minute') n`,
      [T.bob],
      { commit: true },
    );
    expect(s.ok).toBe(true);
    const tick = await run(db.pool, as('mia'), `select mod_workflow_tick() n`, [], { commit: true });
    expect(tick.ok && tick.rows[0].n).toBe(1);
    expect((await q(`select published from forum_threads where id = $1`, [T.bob])).rows[0].published).toBe(
      true,
    );
    const wf = await q(`select status, scheduled_at from content_workflow where target_id = $1`, [T.bob]);
    expect(wf.rows[0]).toMatchObject({ status: 'published', scheduled_at: null });
    const list = await run(
      db.pool,
      as('mia'),
      `select wf_status from mod_list_content('thread') where id = $1`,
      [T.bob],
    );
    expect(list.ok && list.rows[0].wf_status).toBe('published');
  });
  it('定时只能配合「待审」；普通用户不能改流程', async () => {
    const r = await run(
      db.pool,
      as('mia'),
      `select mod_set_workflow('thread', array[$1]::uuid[], 'draft', now())`,
      [T.bob],
    );
    expect(!r.ok && r.code).toBe('22023');
    const u = await run(
      db.pool,
      as('alice'),
      `select mod_set_workflow('thread', array[$1]::uuid[], 'offline')`,
      [T.alice],
    );
    expect(!u.ok && u.code).toBe('42501');
    const tick = await run(db.pool, as('alice'), `select mod_workflow_tick()`);
    expect(!tick.ok && tick.code).toBe('42501');
  });
  it('改正文时保存旧版本；版主可读，普通用户读不到', async () => {
    const before = (await q(`select body from forum_threads where id = $1`, [T.bob])).rows[0].body as string;
    await q(`update forum_threads set body = body || ' （补充）' where id = $1`, [T.bob]);
    const v = await run(
      db.pool,
      as('mia'),
      `select body from content_versions where target_id = $1 order by id desc`,
      [T.bob],
    );
    expect(v.ok && v.rows[0].body).toBe(before);
    const u = await run(db.pool, as('alice'), `select count(*)::int n from content_versions`);
    expect(!u.ok || u.rows[0].n === 0).toBe(true);
  });
  it('迁移可重复执行', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0017_admin_crm.sql'), 'utf8');
    await q(sql);
    await q(sql);
    const n = await q(`select count(*)::int n from admin_user_tags`);
    expect(n.rows[0].n).toBe(1);
  });
});
