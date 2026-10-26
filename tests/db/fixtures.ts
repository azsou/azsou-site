/** 固定夹具：5 种身份 + 每种身份各自的内容 + 一个「别人」(bob)。超级用户写入。 */
import type pg from 'pg';

export const U = {
  alice: '00000000-0000-4000-a000-00000000000a', // user
  bob: '00000000-0000-4000-a000-00000000000b', // user（「别人」）
  carol: '00000000-0000-4000-a000-00000000000c', // banned
  mia: '00000000-0000-4000-a000-00000000000d', // moderator
  ada: '00000000-0000-4000-a000-00000000000e', // admin
} as const;

/** 每个身份「自己的」内容 id；bob 的内容是「别人的」 */
const id = (n: number) => `10000000-0000-4000-b000-${String(n).padStart(12, '0')}`;
export const T = {
  alice: id(1),
  bob: id(2),
  carol: id(3),
  mia: id(4),
  ada: id(5),
  bobHidden: id(6), // 未发布
  bobLocked: id(7), // 已锁定
  announce: id(8), // 公告（ada）
} as const;
export const R = {
  alice: id(11),
  bob: id(12),
  carol: id(13),
  mia: id(14),
  ada: id(15),
  bobHidden: id(16),
} as const;
export const C = {
  alice: id(21),
  bob: id(22),
  carol: id(23),
  mia: id(24),
  ada: id(25),
  bobHidden: id(26),
} as const;
export const REP = { alice: id(31), bob: id(32) } as const;

/** baseline（生产现状）没有 moderator / locked / 种子表 / 社交表：只写它支持的那部分 */
export async function seed(c: pg.Client) {
  const migrated = (await c.query(`select to_regclass('public.likes') is not null as m`)).rows[0]
    .m as boolean;
  const users: [string, string, string, boolean][] = [
    [U.alice, 'alice', 'user', false],
    [U.bob, 'bob', 'user', false],
    [U.carol, 'carol', 'user', true],
    [U.mia, 'mia', 'moderator', false],
    [U.ada, 'ada', 'admin', false],
  ];
  for (const [uid, name, role, banned] of users) {
    await c.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
      uid,
      `${name}@example.com`,
      { name },
    ]);
    await c.query(`update public.profiles set role = $2, banned = $3 where id = $1`, [
      uid,
      !migrated && role === 'moderator' ? 'user' : role,
      banned,
    ]);
  }
  const who = ['alice', 'bob', 'carol', 'mia', 'ada'] as const;
  for (const w of who) {
    await c.query(
      `insert into public.forum_threads (id, cat, title, body, author) values ($1, '产品讨论', $2, 'body', $3)`,
      [T[w], `${w} thread`, U[w]],
    );
  }
  await c.query(
    `insert into public.forum_threads (id, cat, title, body, author, published) values ($1, '技术交流', 'hidden', 'body', $2, false)`,
    [T.bobHidden, U.bob],
  );
  await c.query(
    migrated
      ? `insert into public.forum_threads (id, cat, title, body, author, locked) values ($1, '技术交流', 'locked', 'body', $2, true)`
      : `insert into public.forum_threads (id, cat, title, body, author) values ($1, '技术交流', 'locked', 'body', $2)`,
    [T.bobLocked, U.bob],
  );
  await c.query(
    `insert into public.forum_threads (id, cat, title, body, author, pinned) values ($1, '公告', 'announce', 'body', $2, true)`,
    [T.announce, U.ada],
  );
  for (const w of who) {
    await c.query(
      `insert into public.forum_replies (id, thread_id, body, author) values ($1, $2, 'reply', $3)`,
      [R[w], T.bob, U[w]],
    );
    await c.query(
      `insert into public.comments (id, page_key, body, author) values ($1, 'article:pinyin-initial-search', 'comment', $2)`,
      [C[w], U[w]],
    );
  }
  await c.query(
    `insert into public.forum_replies (id, thread_id, body, author, published) values ($1, $2, 'hidden', $3, false)`,
    [R.bobHidden, T.bob, U.bob],
  );
  await c.query(
    `insert into public.comments (id, page_key, body, author, published) values ($1, 'article:x', 'hidden', $2, false)`,
    [C.bobHidden, U.bob],
  );
  // 种子主题：t-feedback 锁定
  if (migrated) await c.query(`update public.forum_seed_threads set locked = true where key = 't-feedback'`);
  await c.query(
    `insert into public.forum_replies (thread_id, body, author) values ('t-announce', 'seed reply', $1)`,
    [U.bob],
  );
  // 站点内容：1 条发布 + 1 条草稿
  await c.query(`insert into public.site_content (kind, slug, data, published) values
    ('app', 'demo', '{"t":1}', true), ('app', 'draft', '{"t":2}', false)`);
  if (!migrated) return;
  // 点赞 / 收藏 / 举报 / 通知 / 审计
  for (const w of who) {
    await c.query(`insert into public.likes (user_id, target_type, target_id) values ($1, 'thread', $2)`, [
      U[w],
      T.bob,
    ]);
    await c.query(`insert into public.bookmarks (user_id, thread_key) values ($1, $2)`, [U[w], T.bob]);
    await c.query(`insert into public.notifications (user_id, kind, excerpt) values ($1, 'system', 'hi')`, [
      U[w],
    ]);
  }
  await c.query(
    `insert into public.reports (id, reporter, target_type, target_id, reason) values ($1, $2, 'thread', $3, 'spam'), ($4, $5, 'thread', $3, 'abuse')`,
    [REP.alice, U.alice, T.bob, REP.bob, U.bob],
  );
  await c.query(`insert into public.audit_log (actor, action) values ($1, 'seed')`, [U.ada]);
  await c.query(`insert into public.rate_limit_events (user_id, action) values ($1, 'seed')`, [U.alice]);
}
