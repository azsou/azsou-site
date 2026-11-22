/**
 * P6：0012 应用商店——评价（app_reviews）RLS / 约束 / 限流 / 审核复用，聚合视图，
 * 下载计数（app_download_counts + app_count_download RPC：去重、限流、爬虫过滤、权限）。
 * 每个用例在独立事务里执行后回滚（与 PostgREST 一样 SET LOCAL ROLE + request.jwt.claims）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run, runSeq, verdict, type Who } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;

const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const su = { role: 'superuser' } as const;

const RV = {
  bob: '20000000-0000-4000-b000-000000000001', // bob · fablemotion · 4 星 · 已发布
  bobHidden: '20000000-0000-4000-b000-000000000002', // bob · capture-kit · 2 星 · 已隐藏
  alice: '20000000-0000-4000-b000-000000000003', // alice · capture-kit · 5 星
  mia: '20000000-0000-4000-b000-000000000004', // mia · fablemotion · 5 星
} as const;

beforeAll(async () => {
  db = await freshDb('p6');
  const rows: [string, string, string, number, boolean][] = [
    [RV.bob, 'fablemotion', U.bob, 4, true],
    [RV.bobHidden, 'capture-kit', U.bob, 2, false],
    [RV.alice, 'capture-kit', U.alice, 5, true],
    [RV.mia, 'fablemotion', U.mia, 5, true],
  ];
  for (const [id, app, author, rating, published] of rows)
    await db.pool.query(
      `insert into public.app_reviews (id, app, author, rating, title, body, published)
       values ($1, $2, $3, $4, '标题', '正文', $5)`,
      [id, app, author, rating, published],
    );
});
afterAll(async () => {
  await db?.close();
});

const INSERT = `insert into public.app_reviews (app, author, rating, title, body) values ($1, $2, $3, $4, $5) returning id`;
const review = (who: Who, app: string, author: string, rating = 5, body = '好用') =>
  run(db.pool, who, INSERT, [app, author, rating, '', body]);

describe('0012 app_reviews：读', () => {
  it('匿名只能读到已发布的评价', async () => {
    const r = await run(db.pool, anon, `select id from public.app_reviews order by id`);
    expect(r.ok && r.rows.map((x) => x.id)).toEqual([RV.bob, RV.alice, RV.mia]);
  });
  it('作者能读到自己被隐藏的评价，别人不能；版主能读到全部', async () => {
    const q = `select id from public.app_reviews where id = $1`;
    expect(verdict(await run(db.pool, as(U.bob), q, [RV.bobHidden]))).toBe('allow');
    expect(verdict(await run(db.pool, as(U.alice), q, [RV.bobHidden]))).toBe('deny');
    expect(verdict(await run(db.pool, as(U.mia), q, [RV.bobHidden]))).toBe('allow');
  });
  it('可以嵌入作者昵称（profiles 外键）', async () => {
    const r = await run(
      db.pool,
      anon,
      `select p.display_name from public.app_reviews r join public.profiles p on p.id = r.author where r.id = $1`,
      [RV.bob],
    );
    expect(r.ok && r.rows[0]).toEqual({ display_name: 'bob' });
  });
});

describe('0012 app_reviews：写', () => {
  it('匿名不能写', async () => {
    expect(verdict(await review(anon, 'hermes', U.alice))).toBe('deny');
  });
  it('登录用户可以给应用写一条评价（可只打星）', async () => {
    expect(verdict(await review(as(U.alice), 'hermes', U.alice))).toBe('allow');
    expect(verdict(await review(as(U.alice), 'hermes', U.alice, 3, ''))).toBe('allow');
  });
  it('不能冒充别人', async () => {
    expect(verdict(await review(as(U.alice), 'hermes', U.bob))).toBe('deny');
  });
  it('被封禁用户不能写', async () => {
    expect(verdict(await review(as(U.carol), 'hermes', U.carol))).toBe('deny');
  });
  it('每人每个应用只能一条（23505）', async () => {
    const r = await review(as(U.bob), 'fablemotion', U.bob);
    expect(r.ok ? 'ok' : r.code).toBe('23505');
  });
  it.each([
    ['0 星', 0, 'x'],
    ['6 星', 6, 'x'],
    ['正文超过 1000 字', 5, 'x'.repeat(1001)],
  ])('约束：%s 被拒（23514）', async (_n, rating, body) => {
    const r = await review(as(U.alice), 'hermes', U.alice, rating, body);
    expect(r.ok ? 'ok' : r.code).toBe('23514');
  });
  it('应用标识必须是 slug', async () => {
    const r = await review(as(U.alice), 'Bad Slug', U.alice);
    expect(r.ok ? 'ok' : r.code).toBe('23514');
  });
  it('普通用户不能以「未发布」写入，也不能自己隐藏 / 恢复', async () => {
    const ins = await run(
      db.pool,
      as(U.alice),
      `insert into public.app_reviews (app, author, rating, published) values ('hermes', $1, 5, false)`,
      [U.alice],
    );
    expect(verdict(ins)).toBe('deny');
    expect(
      verdict(
        await run(db.pool, as(U.bob), `update public.app_reviews set published = true where id = $1`, [
          RV.bobHidden,
        ]),
      ),
    ).toBe('deny');
  });
  it('作者可以修改自己的评价，edited_at 被设置；不能改 app / author', async () => {
    const r = await run(
      db.pool,
      as(U.bob),
      `update public.app_reviews set rating = 3, body = '改了' where id = $1 returning edited_at`,
      [RV.bob],
    );
    expect(r.ok && r.rows[0].edited_at).toBeTruthy();
    expect(
      verdict(
        await run(db.pool, as(U.bob), `update public.app_reviews set app = 'hermes' where id = $1`, [RV.bob]),
      ),
    ).toBe('deny');
  });
  it('不能修改 / 删除别人的评价', async () => {
    expect(
      verdict(
        await run(db.pool, as(U.alice), `update public.app_reviews set rating = 1 where id = $1`, [RV.bob]),
      ),
    ).toBe('deny');
    expect(
      verdict(await run(db.pool, as(U.alice), `delete from public.app_reviews where id = $1`, [RV.bob])),
    ).toBe('deny');
  });
  it('作者可以删除自己的评价', async () => {
    expect(
      verdict(await run(db.pool, as(U.bob), `delete from public.app_reviews where id = $1`, [RV.bob])),
    ).toBe('allow');
  });
  it('版主可以隐藏 / 删除别人的评价，隐藏时记审计并通知作者', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.mia, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const hide = await c.query(`update public.app_reviews set published = false where id = $1`, [RV.bob]);
      const del = await c.query(`delete from public.app_reviews where id = $1`, [RV.alice]);
      expect([hide.rowCount, del.rowCount]).toEqual([1, 1]);
      await c.query('reset role');
      const audit = await c.query(
        `select action from public.audit_log where target_type = 'review' order by id`,
      );
      expect(audit.rows.map((x) => x.action)).toEqual(['review.update', 'review.delete']);
      const note = await c.query(
        `select kind from public.notifications where user_id = $1 and target_type = 'review'`,
        [U.bob],
      );
      expect(note.rows).toEqual([{ kind: 'moderation' }]);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('限流：同一用户一小时最多 10 条新评价（PT429）', async () => {
    const stmts: [string, unknown[]][] = Array.from({ length: 11 }, (_, i) => [
      INSERT,
      [`rate-app-${i}`, U.alice, 5, '', ''],
    ]);
    const out = await runSeq(db.pool, as(U.alice), stmts);
    expect(out.slice(0, 10).every((o) => o.ok)).toBe(true);
    expect(out[10].ok ? 'ok' : out[10].code).toBe('PT429');
  });
  it('版主不受限流', async () => {
    const stmts: [string, unknown[]][] = Array.from({ length: 12 }, (_, i) => [
      INSERT,
      [`mod-app-${i}`, U.mia, 5, '', ''],
    ]);
    const out = await runSeq(db.pool, as(U.mia), stmts);
    expect(out.every((o) => o.ok)).toBe(true);
  });
});

describe('0012 app_review_stats', () => {
  it('匿名可读；只统计已发布的评价；平均分与星级分布正确', async () => {
    const r = await run(
      db.pool,
      anon,
      `select app, reviews, average::text, r5, r4, r3, r2, r1 from public.app_review_stats order by app`,
    );
    expect(r.ok && r.rows).toEqual([
      { app: 'capture-kit', reviews: 1, average: '5.00', r5: 1, r4: 0, r3: 0, r2: 0, r1: 0 },
      { app: 'fablemotion', reviews: 2, average: '4.50', r5: 1, r4: 1, r3: 0, r2: 0, r1: 0 },
    ]);
  });
  it('作者看自己被隐藏的评价也不会进统计', async () => {
    const r = await run(
      db.pool,
      as(U.bob),
      `select reviews from public.app_review_stats where app = 'capture-kit'`,
    );
    expect(r.ok && r.rows).toEqual([{ reviews: 1 }]);
  });
  it('没有评价的应用不出现（前端显示「暂无评分」，不伪造）', async () => {
    const r = await run(db.pool, anon, `select * from public.app_review_stats where app = 'hermes'`);
    expect(verdict(r)).toBe('deny');
  });
});

describe('0012 举报 / 审核复用', () => {
  it('可以举报评价；版主「隐藏」处理会隐藏评价并通知作者', async () => {
    const out = await runSeq(db.pool, su, [
      [
        `insert into public.reports (reporter, target_type, target_id, reason) values ($1, 'review', $2, 'spam') returning id`,
        [U.alice, RV.mia],
      ],
    ]);
    expect(out[0].ok).toBe(true);
    const rep = await run(
      db.pool,
      as(U.alice),
      `insert into public.reports (reporter, target_type, target_id, reason) values ($1, 'review', $2, 'abuse')`,
      [U.alice, RV.bob],
    );
    expect(verdict(rep)).toBe('allow');
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      const id = (
        await c.query(
          `insert into public.reports (reporter, target_type, target_id, reason) values ($1, 'review', $2, 'spam') returning id`,
          [U.alice, RV.bob],
        )
      ).rows[0].id;
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: U.mia, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const n = await c.query(
        `select public.mod_handle_reports(array[$1::uuid], 'resolved', '广告', 'hide')`,
        [id],
      );
      expect(n.rows[0].mod_handle_reports).toBe(1);
      await c.query('reset role');
      const r = await c.query(`select published from public.app_reviews where id = $1`, [RV.bob]);
      expect(r.rows[0].published).toBe(false);
      const notes = await c.query(
        `select kind from public.notifications where user_id = $1 and target_type = 'review' order by id`,
        [U.bob],
      );
      expect(notes.rows.map((x) => x.kind)).toContain('moderation');
      const author = await c.query(`select public.az_target_author('review', $1) as a`, [RV.bob]);
      expect(author.rows[0].a).toBe(U.bob);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('未知的举报类型仍被拒绝', async () => {
    const r = await run(
      db.pool,
      as(U.alice),
      `insert into public.reports (reporter, target_type, target_id, reason) values ($1, 'app', 'x', 'spam')`,
      [U.alice],
    );
    expect(r.ok ? 'ok' : r.code).toBe('23514');
  });
});

const HEADERS = (h: Record<string, string>) =>
  [`select set_config('request.headers', $1, true)`, [JSON.stringify(h)]] as [string, unknown[]];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36';
const COUNT = (app = 'fablemotion', platform = 'windows'): [string, unknown[]] => [
  `select public.app_count_download($1, $2)::int as n`,
  [app, platform],
];
const n = (o: { ok: boolean; rows?: Record<string, unknown>[] }) => (o.ok ? Number(o.rows![0].n) : NaN);

describe('0012 下载计数', () => {
  it('匿名可读计数表，但不能直接写', async () => {
    expect((await run(db.pool, anon, `select * from public.app_download_counts`)).ok).toBe(true);
    for (const sql of [
      `insert into public.app_download_counts (app, platform, downloads) values ('x', 'web', 999)`,
      `update public.app_download_counts set downloads = 999`,
      `delete from public.app_download_counts`,
    ]) {
      const r = await run(db.pool, anon, sql);
      expect(r.ok ? 'ok' : r.code, sql).toBe('42501');
      const u = await run(db.pool, as(U.alice), sql);
      expect(u.ok ? 'ok' : u.code, sql).toBe('42501');
    }
  });
  it('访客事件表与盐在 private schema，API 角色读不到', async () => {
    for (const t of ['private.app_download_events', 'private.app_settings']) {
      const r = await run(db.pool, anon, `select * from ${t}`);
      expect(r.ok ? 'ok' : r.code).toBe('42501');
    }
  });
  it('真实访客：第一次 +1；同一访客 24 小时内重复下载不重复计数；换一个访客再 +1', async () => {
    const out = await runSeq(db.pool, anon, [
      HEADERS({ 'user-agent': UA, 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
      COUNT(),
      COUNT(),
      HEADERS({ 'user-agent': UA, 'x-forwarded-for': '203.0.113.8' }),
      COUNT(),
      [
        `select downloads::int as n from public.app_download_counts where app = 'fablemotion' and platform = 'windows'`,
      ],
    ]);
    expect([n(out[1]), n(out[2]), n(out[4]), n(out[5])]).toEqual([1, 1, 2, 2]);
  });
  it('不同平台分别计数', async () => {
    const out = await runSeq(db.pool, anon, [
      HEADERS({ 'user-agent': UA, 'cf-connecting-ip': '198.51.100.1' }),
      COUNT('fablemotion', 'windows'),
      COUNT('fablemotion', 'web'),
    ]);
    expect([n(out[1]), n(out[2])]).toEqual([1, 1]);
  });
  it.each([
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['Headless Chrome', 'Mozilla/5.0 HeadlessChrome/141.0'],
    ['curl', 'curl/8.5.0'],
    ['python', 'python-requests/2.32'],
    ['Lighthouse', 'Mozilla/5.0 Chrome-Lighthouse'],
    ['空 UA', ''],
  ])('爬虫 / 脚本不计数：%s', async (_n, ua) => {
    const out = await runSeq(db.pool, anon, [
      HEADERS({ 'user-agent': ua, 'x-forwarded-for': '192.0.2.9' }),
      COUNT(),
    ]);
    expect(n(out[1])).toBe(0);
  });
  it('没有请求头（直连数据库）也不计数', async () => {
    const out = await runSeq(db.pool, anon, [COUNT()]);
    expect(n(out[0])).toBe(0);
  });
  it('限流：同一访客每小时最多计 20 次，超出不报错只是不再计数', async () => {
    const stmts: [string, unknown[]][] = [HEADERS({ 'user-agent': UA, 'x-forwarded-for': '192.0.2.50' })];
    for (let i = 0; i < 22; i++) stmts.push(COUNT(`rl-app-${i}`, 'web'));
    const out = await runSeq(db.pool, anon, stmts);
    const counts = out.slice(1).map(n);
    expect(counts.slice(0, 20).every((x) => x === 1)).toBe(true);
    expect(counts.slice(20)).toEqual([0, 0]);
  });
  it('登录用户按账号去重（换 IP 也只计一次）', async () => {
    const out = await runSeq(db.pool, as(U.alice), [
      HEADERS({ 'user-agent': UA, 'x-forwarded-for': '192.0.2.60' }),
      COUNT('hermes', 'web'),
      HEADERS({ 'user-agent': UA, 'x-forwarded-for': '192.0.2.61' }),
      COUNT('hermes', 'web'),
    ]);
    expect([n(out[1]), n(out[3])]).toEqual([1, 1]);
  });
  it.each([
    ['非法应用标识', 'Bad App', 'web'],
    ['超长应用标识', 'a'.repeat(61), 'web'],
    ['未知平台', 'fablemotion', 'symbian'],
  ])('参数校验：%s（22023）', async (_n, app, platform) => {
    const out = await runSeq(db.pool, anon, [HEADERS({ 'user-agent': UA }), COUNT(app, platform)]);
    expect(out[1].ok ? 'ok' : (out[1] as { code: string }).code).toBe('22023');
  });
  it('访客只存加盐哈希，不存 IP', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify({ 'user-agent': UA, 'x-forwarded-for': '203.0.113.99' }),
      ]);
      await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await c.query('set local role anon');
      await c.query(`select public.app_count_download('capture-kit', 'browser-ext')`);
      await c.query('reset role');
      const r = await c.query(`select visitor from private.app_download_events`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].visitor).toMatch(/^[0-9a-f]{64}$/);
      expect(r.rows[0].visitor).not.toContain('203.0.113.99');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('0012 可重复执行', () => {
  it('再执行一次不报错，数据与盐保留', async () => {
    const salt = (await db.pool.query(`select value from private.app_settings where key = 'download_salt'`))
      .rows[0].value;
    await db.pool.query(readFileSync(join(MIGRATIONS_DIR, '0012_app_store.sql'), 'utf8'));
    const after = await db.pool.query(
      `select (select value from private.app_settings where key = 'download_salt') salt,
              (select count(*)::int from public.app_reviews) reviews,
              (select count(*)::int from pg_policies where tablename = 'app_reviews') policies`,
    );
    expect(after.rows[0]).toEqual({ salt, reviews: 4, policies: 4 });
  });
});
