/**
 * 角色读写矩阵：anon / user / banned / moderator / admin × 每张表 × 读 / 写操作。
 * 每个用例在独立事务里执行后回滚（与 PostgREST 一样 SET LOCAL ROLE + request.jwt.claims）。
 * 结果另存为 test-results/rls-matrix.md，便于审阅。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, run, verdict, type Who } from './helpers';
import { C, R, REP, T, U } from './fixtures';
import { freshDb } from './setup';

type Role = 'anon' | 'user' | 'banned' | 'mod' | 'admin';
const ROLES: Role[] = ['anon', 'user', 'banned', 'mod', 'admin'];
const SELF: Record<Exclude<Role, 'anon'>, keyof typeof U> = {
  user: 'alice',
  banned: 'carol',
  mod: 'mia',
  admin: 'ada',
};
const WHO = (r: Role): Who => (r === 'anon' ? { role: 'anon' } : { role: 'authenticated', uid: U[SELF[r]] });
const me = (r: Role) => (r === 'anon' ? null : SELF[r]);
const uid = (r: Role) => (r === 'anon' ? null : U[SELF[r]]);
const own = <K extends string>(map: Record<K, string>, r: Role) =>
  r === 'anon' ? map['alice' as K] : map[me(r) as K];

type V = 'allow' | 'deny';
const allow = (...rs: Role[]): Record<Role, V> =>
  Object.fromEntries(ROLES.map((r) => [r, rs.includes(r) ? 'allow' : 'deny'])) as Record<Role, V>;
const NOBODY = allow();
const WRITERS = allow('user', 'mod', 'admin');
const MODS = allow('mod', 'admin');
const ADMIN = allow('admin');
const SIGNED_IN = allow('user', 'banned', 'mod', 'admin');

interface WriteCase {
  table: string;
  name: string;
  sql: (r: Role) => [string, unknown[]];
  expect: Record<Role, V>;
}

const W: WriteCase[] = [
  // ---------------------------------------------------------------- profiles
  {
    table: 'profiles',
    name: '改自己的昵称',
    expect: WRITERS,
    sql: (r) => [`update profiles set display_name = 'x' where id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'profiles',
    name: '改别人的昵称',
    expect: NOBODY,
    sql: () => [`update profiles set display_name = 'x' where id = $1`, [U.bob]],
  },
  {
    table: 'profiles',
    name: '把自己改成 admin（直接 UPDATE role）',
    expect: NOBODY,
    sql: (r) => [`update profiles set role = 'admin' where id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'profiles',
    name: '解除自己的封禁（直接 UPDATE banned）',
    expect: NOBODY,
    sql: (r) => [`update profiles set banned = false where id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'profiles',
    name: '插入资料行',
    expect: NOBODY,
    sql: () => [`insert into profiles (id, display_name) values (gen_random_uuid(), 'x')`, []],
  },
  {
    table: 'profiles',
    name: '删除自己的资料',
    expect: NOBODY,
    sql: (r) => [`delete from profiles where id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'profiles',
    name: 'rpc admin_set_user(bob → moderator)',
    expect: ADMIN,
    sql: () => [`select admin_set_user($1, 'moderator', false)`, [U.bob]],
  },
  // ------------------------------------------------------------ site_content
  {
    table: 'site_content',
    name: '新增内容',
    expect: ADMIN,
    sql: () => [`insert into site_content (kind, slug, data) values ('app', 'new', '{}')`, []],
  },
  {
    table: 'site_content',
    name: 'V72 upsert（on conflict do update）',
    expect: ADMIN,
    sql: () => [
      `insert into site_content (kind, slug, data, published) values ('app', 'demo', '{"t":9}', true) on conflict (kind, slug) do update set data = excluded.data, published = excluded.published`,
      [],
    ],
  },
  {
    table: 'site_content',
    name: '修改 published',
    expect: ADMIN,
    sql: () => [`update site_content set published = false where slug = 'demo'`, []],
  },
  {
    table: 'site_content',
    name: '删除',
    expect: ADMIN,
    sql: () => [`delete from site_content where slug = 'demo'`, []],
  },
  // ----------------------------------------------------------- forum_threads
  {
    table: 'forum_threads',
    name: '发主题（普通分类）',
    expect: WRITERS,
    sql: (r) => [
      `insert into forum_threads (cat, title, body, author) values ('产品讨论', 't', 'b', $1)`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_threads',
    name: '在「公告」发主题',
    expect: ADMIN,
    sql: (r) => [
      `insert into forum_threads (cat, title, body, author) values ('公告', 't', 'b', $1)`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_threads',
    name: '发主题时 pinned = true',
    expect: MODS,
    sql: (r) => [
      `insert into forum_threads (cat, title, body, author, pinned) values ('产品讨论', 't', 'b', $1, true)`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_threads',
    name: '发主题时伪造 created_at',
    expect: NOBODY,
    sql: (r) => [
      `insert into forum_threads (cat, title, body, author, created_at) values ('产品讨论', 't', 'b', $1, '2000-01-01')`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_threads',
    name: '以别人的名义发主题',
    expect: NOBODY,
    sql: () => [
      `insert into forum_threads (cat, title, body, author) values ('产品讨论', 't', 'b', $1)`,
      [U.bob],
    ],
  },
  {
    table: 'forum_threads',
    name: '编辑自己的主题',
    expect: WRITERS,
    sql: (r) => [`update forum_threads set title = 'edited' where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '编辑别人的主题',
    // A04（0018，站长 2026-10-27 已定）：他人的标题 / 正文只能由管理员经 mod_edit_content()（带理由）修改，任何人直接 PATCH 都拒绝
    expect: NOBODY,
    sql: () => [`update forum_threads set title = 'edited' where id = $1`, [T.bob]],
  },
  {
    table: 'forum_threads',
    name: '置顶自己的主题',
    expect: MODS,
    sql: (r) => [`update forum_threads set pinned = true where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '把自己的主题移到「公告」',
    expect: ADMIN,
    sql: (r) => [`update forum_threads set cat = '公告' where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '隐藏自己的主题（published=false）',
    expect: MODS,
    sql: (r) => [`update forum_threads set published = false where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '改 created_at',
    expect: NOBODY,
    sql: (r) => [`update forum_threads set created_at = '2000-01-01' where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '锁定别人的主题',
    expect: MODS,
    sql: () => [`update forum_threads set locked = true where id = $1`, [T.bob]],
  },
  {
    table: 'forum_threads',
    name: '编辑已锁定的主题（作者 bob 视角见回归测试）',
    // A04（0018，站长 2026-10-27 已定）：他人的标题 / 正文只能由管理员经 mod_edit_content()（带理由）修改，任何人直接 PATCH 都拒绝
    expect: NOBODY,
    sql: () => [`update forum_threads set title = 'x' where id = $1`, [T.bobLocked]],
  },
  {
    table: 'forum_threads',
    name: '删除自己的主题',
    expect: SIGNED_IN,
    sql: (r) => [`delete from forum_threads where id = $1`, [own(T, r)]],
  },
  {
    table: 'forum_threads',
    name: '删除别人的主题',
    expect: MODS,
    sql: () => [`delete from forum_threads where id = $1`, [T.bob]],
  },
  // ----------------------------------------------------------- forum_replies
  {
    table: 'forum_replies',
    name: '回复已发布主题（V72 写法：thread_id 文本）',
    expect: WRITERS,
    sql: (r) => [`insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`, [T.bob, uid(r)]],
  },
  {
    table: 'forum_replies',
    name: '回复已锁定主题',
    expect: MODS,
    sql: (r) => [
      `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`,
      [T.bobLocked, uid(r)],
    ],
  },
  {
    table: 'forum_replies',
    name: '回复未发布主题',
    expect: MODS,
    sql: (r) => [
      `insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`,
      [T.bobHidden, uid(r)],
    ],
  },
  {
    table: 'forum_replies',
    name: '回复种子主题 t-announce',
    expect: WRITERS,
    sql: (r) => [
      `insert into forum_replies (thread_id, body, author) values ('t-announce', 'r', $1)`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_replies',
    name: '回复已锁定的种子主题 t-feedback',
    expect: MODS,
    sql: (r) => [
      `insert into forum_replies (thread_id, body, author) values ('t-feedback', 'r', $1)`,
      [uid(r)],
    ],
  },
  {
    table: 'forum_replies',
    name: '以别人的名义回复',
    expect: NOBODY,
    sql: () => [`insert into forum_replies (thread_id, body, author) values ($1, 'r', $2)`, [T.bob, U.bob]],
  },
  {
    table: 'forum_replies',
    name: '编辑自己的回复',
    expect: WRITERS,
    sql: (r) => [`update forum_replies set body = 'e' where id = $1`, [own(R, r)]],
  },
  {
    table: 'forum_replies',
    name: '编辑别人的回复',
    // A04（0018，站长 2026-10-27 已定）：他人的标题 / 正文只能由管理员经 mod_edit_content()（带理由）修改，任何人直接 PATCH 都拒绝
    expect: NOBODY,
    sql: () => [`update forum_replies set body = 'e' where id = $1`, [R.bob]],
  },
  {
    table: 'forum_replies',
    name: '隐藏自己的回复',
    expect: MODS,
    sql: (r) => [`update forum_replies set published = false where id = $1`, [own(R, r)]],
  },
  {
    table: 'forum_replies',
    name: '把回复挪到别的主题',
    expect: NOBODY,
    sql: (r) => [`update forum_replies set thread_id = $2 where id = $1`, [own(R, r), T.alice]],
  },
  {
    table: 'forum_replies',
    name: '删除自己的回复',
    expect: SIGNED_IN,
    sql: (r) => [`delete from forum_replies where id = $1`, [own(R, r)]],
  },
  {
    table: 'forum_replies',
    name: '删除别人的回复',
    expect: MODS,
    sql: () => [`delete from forum_replies where id = $1`, [R.bob]],
  },
  // ---------------------------------------------------------------- comments
  {
    table: 'comments',
    name: '发评论',
    expect: WRITERS,
    sql: (r) => [`insert into comments (page_key, body, author) values ('article:x', 'c', $1)`, [uid(r)]],
  },
  {
    table: 'comments',
    name: '以别人的名义评论',
    expect: NOBODY,
    sql: () => [`insert into comments (page_key, body, author) values ('article:x', 'c', $1)`, [U.bob]],
  },
  {
    table: 'comments',
    name: '评论时伪造 created_at',
    expect: NOBODY,
    sql: (r) => [
      `insert into comments (page_key, body, author, created_at) values ('article:x', 'c', $1, '2000-01-01')`,
      [uid(r)],
    ],
  },
  {
    table: 'comments',
    name: '编辑自己的评论',
    expect: WRITERS,
    sql: (r) => [`update comments set body = 'e' where id = $1`, [own(C, r)]],
  },
  {
    table: 'comments',
    name: '编辑别人的评论',
    // A04（0018，站长 2026-10-27 已定）：他人的标题 / 正文只能由管理员经 mod_edit_content()（带理由）修改，任何人直接 PATCH 都拒绝
    expect: NOBODY,
    sql: () => [`update comments set body = 'e' where id = $1`, [C.bob]],
  },
  {
    table: 'comments',
    name: '隐藏别人的评论',
    expect: MODS,
    sql: () => [`update comments set published = false where id = $1`, [C.bob]],
  },
  {
    table: 'comments',
    name: '删除自己的评论',
    expect: SIGNED_IN,
    sql: (r) => [`delete from comments where id = $1`, [own(C, r)]],
  },
  {
    table: 'comments',
    name: '删除别人的评论',
    expect: MODS,
    sql: () => [`delete from comments where id = $1`, [C.bob]],
  },
  // ------------------------------------------------------ forum_seed_threads
  {
    table: 'forum_seed_threads',
    name: '锁定种子主题',
    expect: MODS,
    sql: () => [`update forum_seed_threads set locked = true where key = 't-announce'`, []],
  },
  {
    table: 'forum_seed_threads',
    name: '新增种子主题',
    expect: NOBODY,
    sql: () => [`insert into forum_seed_threads (key) values ('t-new')`, []],
  },
  // ------------------------------------------------------------------- likes
  {
    table: 'likes',
    name: '点赞',
    expect: WRITERS,
    sql: (r) => [
      `insert into likes (user_id, target_type, target_id) values ($1, 'thread', $2)`,
      [uid(r), T.alice],
    ],
  },
  {
    table: 'likes',
    name: '替别人点赞',
    expect: NOBODY,
    sql: () => [
      `insert into likes (user_id, target_type, target_id) values ($1, 'thread', $2)`,
      [U.bob, T.alice],
    ],
  },
  {
    table: 'likes',
    name: '取消自己的赞',
    expect: SIGNED_IN,
    sql: (r) => [`delete from likes where user_id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'likes',
    name: '删别人的赞',
    expect: NOBODY,
    sql: () => [`delete from likes where user_id = $1`, [U.bob]],
  },
  // --------------------------------------------------------------- bookmarks
  {
    table: 'bookmarks',
    name: '收藏',
    expect: SIGNED_IN,
    sql: (r) => [`insert into bookmarks (user_id, thread_key) values ($1, $2)`, [uid(r), T.alice]],
  },
  {
    table: 'bookmarks',
    name: '删别人的收藏',
    expect: NOBODY,
    sql: () => [`delete from bookmarks where user_id = $1`, [U.bob]],
  },
  // ----------------------------------------------------------------- reports
  {
    table: 'reports',
    name: '举报',
    expect: WRITERS,
    sql: (r) => [
      `insert into reports (reporter, target_type, target_id, reason) values ($1, 'thread', $2, 'other')`,
      [uid(r), T.ada],
    ],
  },
  {
    table: 'reports',
    name: '处理举报（status=resolved）',
    expect: MODS,
    sql: () => [`update reports set status = 'resolved' where id = $1`, [REP.alice]],
  },
  {
    table: 'reports',
    name: '删除举报',
    expect: NOBODY,
    sql: () => [`delete from reports where id = $1`, [REP.alice]],
  },
  // ----------------------------------------------------------- notifications
  {
    table: 'notifications',
    name: '标记自己的通知已读',
    expect: SIGNED_IN,
    sql: (r) => [`update notifications set read_at = now() where user_id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'notifications',
    name: '标记别人的通知已读',
    expect: NOBODY,
    sql: () => [`update notifications set read_at = now() where user_id = $1`, [U.bob]],
  },
  {
    table: 'notifications',
    name: '伪造通知',
    expect: NOBODY,
    sql: (r) => [`insert into notifications (user_id, kind) values ($1, 'system')`, [uid(r) ?? U.alice]],
  },
  {
    table: 'notifications',
    name: '改通知内容',
    expect: NOBODY,
    sql: (r) => [`update notifications set excerpt = 'x' where user_id = $1`, [uid(r) ?? U.alice]],
  },
  {
    table: 'notifications',
    name: 'rpc mark_notifications_read()',
    expect: SIGNED_IN,
    sql: () => [`select mark_notifications_read()`, []],
  },
  // --------------------------------------------------------------- audit_log
  {
    table: 'audit_log',
    name: '写审计日志',
    expect: NOBODY,
    sql: () => [`insert into audit_log (action) values ('x')`, []],
  },
  { table: 'audit_log', name: '删审计日志', expect: NOBODY, sql: () => [`delete from audit_log`, []] },
  // ------------------------------------------------------- user_bans（0009）
  {
    table: 'user_bans',
    name: '直接写封禁记录',
    expect: NOBODY,
    sql: (r) => [`insert into user_bans (user_id, reason) values ($1, 'x')`, [uid(r) ?? U.alice]],
  },
  {
    table: 'user_bans',
    name: '删除封禁记录',
    expect: NOBODY,
    sql: () => [`delete from user_bans`, []],
  },
  {
    table: 'user_bans',
    name: 'rpc mod_ban_user(普通用户)',
    expect: MODS,
    sql: () => [`select mod_ban_user($1, 'x')`, [U.bob]],
  },
  {
    table: 'user_bans',
    name: 'rpc mod_handle_reports(驳回)',
    expect: MODS,
    sql: () => [`select mod_handle_reports(array[$1]::uuid[], 'dismissed')`, [REP.alice]],
  },
  {
    table: 'user_bans',
    name: 'rpc admin_stats()',
    expect: MODS,
    sql: () => [`select admin_stats()`, []],
  },
  // ------------------------------------------------------- rate_limit_events
  {
    table: 'rate_limit_events',
    name: '清空自己的限流计数',
    expect: NOBODY,
    sql: (r) => [`delete from rate_limit_events where user_id = $1`, [uid(r) ?? U.alice]],
  },
];

// 读：每个角色能看到几行。expected 用超级用户按条件计数，'denied' = 没有 SELECT 权限
type ReadSpec = { table: string; expected: (r: Role) => string | 'denied' };
const visibleUgc = (r: Role) =>
  r === 'mod' || r === 'admin' ? 'true' : r === 'anon' ? 'published' : `published or author = '${uid(r)}'`;
const ownOnly = (col: string) => (r: Role) => (r === 'anon' ? 'denied' : `${col} = '${uid(r)}'`);
const READS: ReadSpec[] = [
  { table: 'profiles', expected: () => 'true' },
  { table: 'site_content', expected: (r) => (r === 'admin' ? 'true' : 'published') },
  { table: 'forum_threads', expected: visibleUgc },
  { table: 'forum_replies', expected: visibleUgc },
  { table: 'comments', expected: visibleUgc },
  { table: 'forum_seed_threads', expected: () => 'true' },
  { table: 'likes', expected: () => 'true' },
  { table: 'bookmarks', expected: ownOnly('user_id') },
  {
    table: 'reports',
    expected: (r) =>
      r === 'anon' ? 'denied' : r === 'mod' || r === 'admin' ? 'true' : `reporter = '${uid(r)}'`,
  },
  { table: 'notifications', expected: ownOnly('user_id') },
  { table: 'audit_log', expected: (r) => (r === 'anon' ? 'denied' : r === 'admin' ? 'true' : 'false') },
  { table: 'rate_limit_events', expected: () => 'denied' },
  {
    table: 'user_bans',
    expected: (r) =>
      r === 'anon' ? 'denied' : r === 'mod' || r === 'admin' ? 'true' : `user_id = '${uid(r)}'`,
  },
];

const ALL_TABLES = READS.map((r) => r.table);

let db: Awaited<ReturnType<typeof freshDb>>;
const report: string[] = [];

beforeAll(async () => {
  db = await freshDb('matrix');
}, 60_000);
afterAll(async () => {
  mkdirSync(join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(join(ROOT, 'test-results/rls-matrix.md'), report.join('\n') + '\n');
  await db?.close();
});

describe('读矩阵（可见行数）', () => {
  it.each(READS)('$table', async ({ table, expected }) => {
    const row = [`| ${table} |`];
    for (const r of ROLES) {
      const exp = expected(r);
      const got = await run(db.pool, WHO(r), `select count(*)::int as n from public.${table}`);
      if (exp === 'denied') {
        expect(got.ok, `${table} 对 ${r} 应无 SELECT 权限`).toBe(false);
        if (!got.ok) expect(got.code).toBe('42501');
        row.push(' 无权限 |');
        continue;
      }
      const want = await run(
        db.pool,
        { role: 'superuser' },
        `select count(*)::int as n from public.${table} where ${exp}`,
      );
      expect(got.ok, `${table}/${r}: ${!got.ok ? got.message : ''}`).toBe(true);
      const n = got.ok ? (got.rows[0].n as number) : -1;
      const w = want.ok ? (want.rows[0].n as number) : -2;
      expect(n, `${table} 对 ${r} 可见行数`).toBe(w);
      row.push(` ${n} |`);
    }
    report.push(row.join(''));
  });
});

describe('写矩阵', () => {
  it.each(W)('$table · $name', async (c) => {
    const row = [`| ${c.table} | ${c.name} |`];
    for (const r of ROLES) {
      const [sql, params] = c.sql(r);
      const got = await run(db.pool, WHO(r), sql, params);
      const v = verdict(got);
      expect(v, `${c.table}「${c.name}」角色 ${r}${!got.ok ? `：${got.message}` : ''}`).toBe(c.expect[r]);
      row.push(v === 'allow' ? ' ✅ |' : ' ⛔ |');
    }
    report.push(row.join(''));
  });
});

describe('危险权限', () => {
  it.each(ALL_TABLES)('%s：anon / authenticated 不能 TRUNCATE', async (table) => {
    for (const r of ROLES) {
      const got = await run(db.pool, WHO(r), `truncate public.${table} cascade`);
      expect(got.ok, `${r} truncate ${table}`).toBe(false);
    }
  });
});

// 报表头（vitest 先收集再执行，afterAll 时 report 已按执行顺序填好；这里插入表头）
report.push(
  '# RLS 角色矩阵（自动生成：npm run test:db）',
  '',
  '## 读：可见行数',
  '',
  '| 表 | anon | user | banned | moderator | admin |',
  '|---|---|---|---|---|---|',
);
const origPush = report.push.bind(report);
let wroteWriteHeader = false;
report.push = (...items: string[]) => {
  if (!wroteWriteHeader && items[0]?.split('|').length === 9) {
    wroteWriteHeader = true;
    origPush(
      '',
      '## 写：✅ 允许 / ⛔ 拒绝',
      '',
      '| 表 | 操作 | anon | user | banned | moderator | admin |',
      '|---|---|---|---|---|---|---|',
    );
  }
  return origPush(...items);
};
