/**
 * T7.3 / T7.4（迁移 0015）：留言板与友链申请。
 *  - 匿名只能经 RPC + 有效票据写入，写入的一律是 pending；直接 INSERT / UPDATE / DELETE 被拒绝；
 *  - 票据：密钥未配置时拒绝、签名错误 / 过期 / 内容被改 / 重放被拒；
 *  - 限流（同一 client：留言 3 次 / 10 分钟；友链 2 次 / 天）、友链网址去重；
 *  - 公开只读 approved，友链读不到 contact；版主审核留言，只有管理员处理友链；审核写审计；
 *  - 可重复执行。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run, runSeq, verdict } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';
import { clientHash, makeCommunityTicket } from '../../src/lib/server/community-submit';
import { ticketPayload } from '../../src/lib/community-forms';

let db: Awaited<ReturnType<typeof freshDb>>;
const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const SECRET = 'db-test-community-secret';
const SQL = readFileSync(join(MIGRATIONS_DIR, '0015_guestbook.sql'), 'utf8');
let n = 0;
const ip = () => `198.51.100.${++n}`;

const gbTicket = (
  nickname: string,
  body: string,
  opts: { client?: string; ts?: number; secret?: string } = {},
) =>
  makeCommunityTicket(
    opts.secret ?? SECRET,
    'guestbook',
    ticketPayload('guestbook', { nickname, body }),
    opts.client ?? clientHash(SECRET, ip()),
    opts.ts,
  );
const GB = `select public.guestbook_submit($1, $2, $3) as r`;
const LINK = `select public.friend_link_submit($1, $2, $3, $4, $5) as r`;
const linkTicket = (
  v: { name: string; url: string; description: string; contact: string },
  client?: string,
) => makeCommunityTicket(SECRET, 'link', ticketPayload('link', v), client ?? clientHash(SECRET, ip()));

beforeAll(async () => {
  db = await freshDb('guestbook');
  await db.pool.query(
    `insert into private.app_settings (key, value) values ('community_ticket_secret', $1)
     on conflict (key) do update set value = excluded.value`,
    [SECRET],
  );
});
afterAll(async () => {
  await db?.close();
});

const code = (o: Awaited<ReturnType<typeof run>>) => (o.ok ? 'ok' : o.code);

describe('0015 留言：写入只能经 RPC + 票据，且只能是 pending', () => {
  it('匿名带有效票据可以留言，结果是 pending，公开读不到', async () => {
    const r = await run(db.pool, anon, GB, ['路人甲', '你好，站长！', gbTicket('路人甲', '你好，站长！')], {
      commit: true,
    });
    expect(code(r)).toBe('ok');
    const id = (r.ok && (r.rows[0].r as { id: string }).id) as string;
    expect((r.ok && (r.rows[0].r as { status: string }).status) || '').toBe('pending');
    const pub = await run(db.pool, anon, `select id from public.guestbook_entries where id = $1`, [id]);
    expect(verdict(pub)).toBe('deny');
    const mod = await run(db.pool, as(U.mia), `select status from public.guestbook_entries where id = $1`, [
      id,
    ]);
    expect(mod.ok && mod.rows[0].status).toBe('pending');
  });
  it('登录用户同样进待审核（没有自动通过）', async () => {
    const r = await run(db.pool, as(U.alice), GB, [
      'Alice',
      '登录后的留言',
      gbTicket('Alice', '登录后的留言'),
    ]);
    expect(r.ok && (r.rows[0].r as { status: string }).status).toBe('pending');
  });
  it('直接 INSERT / UPDATE / DELETE 被拒绝（anon 与 authenticated）', async () => {
    for (const who of [anon, as(U.alice)]) {
      expect(
        verdict(
          await run(
            db.pool,
            who,
            `insert into public.guestbook_entries (nickname, body, status) values ('x', 'y', 'approved')`,
          ),
        ),
      ).toBe('deny');
      expect(
        verdict(await run(db.pool, who, `update public.guestbook_entries set status = 'approved'`)),
      ).toBe('deny');
      expect(verdict(await run(db.pool, who, `delete from public.guestbook_entries`))).toBe('deny');
    }
  });
  it('没有票据 / 签名错误 / 内容被改 / 过期 / 未来时间 被拒绝', async () => {
    const good = gbTicket('乙', '原文');
    const bad = [
      ['乙', '原文', ''],
      ['乙', '原文', 'nope'],
      ['乙', '原文', gbTicket('乙', '原文', { secret: 'wrong-secret' })],
      ['乙', '被改过的内容', good],
      ['乙', '原文', gbTicket('乙', '原文', { ts: Math.floor(Date.now() / 1000) - 3600 })],
      ['乙', '原文', gbTicket('乙', '原文', { ts: Math.floor(Date.now() / 1000) + 3600 })],
    ];
    for (const [a, b, t] of bad)
      expect(code(await run(db.pool, anon, GB, [a, b, t])), `${b} ${t}`).toBe('42501');
  });
  it('同一张票据只能用一次（重放被拒）', async () => {
    const t = gbTicket('丙', '只发一次');
    const seq = await runSeq(db.pool, anon, [
      [GB, ['丙', '只发一次', t]],
      [GB, ['丙', '只发一次', t]],
    ]);
    expect(seq.map((o) => (o.ok ? 'ok' : o.code))).toEqual(['ok', '42501']);
  });
  it('内容校验：昵称 / 长度 / 控制字符 / 链接数量', async () => {
    const cases: [string, string][] = [
      ['', '内容'],
      ['名'.repeat(25), '内容'],
      ['换\n行', '内容'],
      ['丁', ''],
      ['丁', '字'.repeat(501)],
      ['丁', 'a https://a.com b https://b.com c http://c.com'],
    ];
    for (const [a, b] of cases)
      expect(code(await run(db.pool, anon, GB, [a, b, gbTicket(a, b)])), `${a}|${b}`).toBe('22023');
  });
  it('限流：同一访客 10 分钟内最多 3 条；不同访客互不影响', async () => {
    const client = clientHash(SECRET, '203.0.113.9');
    const seq = await runSeq(
      db.pool,
      anon,
      [1, 2, 3, 4].map(
        (i) =>
          [GB, ['限流', `第 ${i} 条`, gbTicket('限流', `第 ${i} 条`, { client })]] as [string, unknown[]],
      ),
    );
    expect(seq.map((o) => (o.ok ? 'ok' : o.code))).toEqual(['ok', 'ok', 'ok', 'PT429']);
    expect(code(await run(db.pool, anon, GB, ['别人', '不受影响', gbTicket('别人', '不受影响')]))).toBe('ok');
  });
  it('密钥未配置时一律拒绝（PT503）', async () => {
    const r = await run(db.pool, anon, GB, ['戊', '内容', gbTicket('戊', '内容')], {
      before: [
        `set local role postgres`,
        `delete from private.app_settings where key = 'community_ticket_secret'`,
        `set local role anon`,
      ],
    });
    expect(code(r)).toBe('PT503');
  });
});

describe('0015 留言：审核', () => {
  let id: string;
  beforeAll(async () => {
    const r = await run(db.pool, anon, GB, ['待审', '请通过', gbTicket('待审', '请通过')], { commit: true });
    id = (r.ok && (r.rows[0].r as { id: string }).id) as string;
  });
  it('普通用户 / 匿名不能审核', async () => {
    for (const who of [anon, as(U.alice), as(U.carol)])
      expect(
        code(
          await run(db.pool, who, `select public.mod_guestbook_set_status($1::uuid[], 'approved')`, [[id]]),
        ),
      ).toBe('42501');
  });
  it('版主通过后公开可读（只读到公开列），并写审计', async () => {
    const r = await run(
      db.pool,
      as(U.mia),
      `select public.mod_guestbook_set_status($1::uuid[], 'approved') as n`,
      [[id]],
      { commit: true },
    );
    expect(r.ok && r.rows[0].n).toBe(1);
    const pub = await run(
      db.pool,
      anon,
      `select nickname, body, status from public.guestbook_entries where id = $1`,
      [id],
    );
    expect(pub.ok && pub.rows[0]).toEqual({ nickname: '待审', body: '请通过', status: 'approved' });
    expect(code(await run(db.pool, anon, `select moderated_by from public.guestbook_entries`))).toBe('42501');
    const audit = await db.pool.query(
      `select actor, action from public.audit_log where target_type = 'guestbook' and target_id = $1`,
      [id],
    );
    expect(audit.rows).toContainEqual({ actor: U.mia, action: 'guestbook.approved' });
  });
  it('版主可以删除；状态值非法被拒', async () => {
    expect(
      code(
        await run(db.pool, as(U.mia), `select public.mod_guestbook_set_status($1::uuid[], 'bogus')`, [[id]]),
      ),
    ).toBe('22023');
    const d = await run(db.pool, as(U.ada), `select public.mod_guestbook_delete($1::uuid[]) as n`, [[id]]);
    expect(d.ok && d.rows[0].n).toBe(1);
  });
});

describe('0015 友链申请', () => {
  const v = {
    name: '某某的博客',
    url: 'https://blog.example.com/',
    description: '写游戏开发',
    contact: 'me@example.com',
  };
  let id: string;
  it('匿名带票据申请 → pending；公开读不到；联系方式任何 API 角色都读不到', async () => {
    const r = await run(db.pool, anon, LINK, [v.name, v.url, v.description, v.contact, linkTicket(v)], {
      commit: true,
    });
    expect(code(r)).toBe('ok');
    id = (r.ok && (r.rows[0].r as { id: string }).id) as string;
    expect(verdict(await run(db.pool, anon, `select id from public.friend_links where id = $1`, [id]))).toBe(
      'deny',
    );
    for (const who of [anon, as(U.alice), as(U.ada)])
      expect(code(await run(db.pool, who, `select contact from public.friend_links`))).toBe('42501');
  });
  it('同一网址在待审核 / 已通过时不能重复申请', async () => {
    expect(
      code(
        await run(db.pool, anon, LINK, [
          v.name,
          v.url,
          '',
          '',
          linkTicket({ ...v, description: '', contact: '' }),
        ]),
      ),
    ).toBe('23505');
  });
  it('网址必须是 https', async () => {
    const w = { ...v, url: 'http://insecure.example.com/' };
    expect(
      code(await run(db.pool, anon, LINK, [w.name, w.url, w.description, w.contact, linkTicket(w)])),
    ).toBe('22023');
  });
  it('限流：同一访客一天最多 2 次', async () => {
    const client = clientHash(SECRET, '203.0.113.77');
    const mk = (i: number) => ({ ...v, url: `https://s${i}.example.org/` });
    const seq = await runSeq(
      db.pool,
      anon,
      [1, 2, 3].map((i) => {
        const w = mk(i);
        return [LINK, [w.name, w.url, w.description, w.contact, linkTicket(w, client)]] as [
          string,
          unknown[],
        ];
      }),
    );
    expect(seq.map((o) => (o.ok ? 'ok' : o.code))).toEqual(['ok', 'ok', 'PT429']);
  });
  it('只有管理员能看申请（含联系方式）与审核；版主不行', async () => {
    expect(
      code(await run(db.pool, as(U.mia), `select * from public.admin_list_friend_links('pending')`)),
    ).toBe('42501');
    expect(
      code(
        await run(db.pool, as(U.mia), `select public.admin_friend_link_set_status($1::uuid[], 'approved')`, [
          [id],
        ]),
      ),
    ).toBe('42501');
    const list = await run(
      db.pool,
      as(U.ada),
      `select id, contact from public.admin_list_friend_links('pending')`,
    );
    expect(list.ok && list.rows.find((r) => r.id === id)?.contact).toBe('me@example.com');
    const ok = await run(
      db.pool,
      as(U.ada),
      `select public.admin_friend_link_set_status($1::uuid[], 'approved') as n`,
      [[id]],
      {
        commit: true,
      },
    );
    expect(ok.ok && ok.rows[0].n).toBe(1);
    const pub = await run(
      db.pool,
      anon,
      `select name, url, description from public.friend_links where id = $1`,
      [id],
    );
    expect(pub.ok && pub.rows[0]).toEqual({ name: v.name, url: v.url, description: v.description });
  });
});

describe('0015 可重复执行', () => {
  it('再执行两次不报错，策略与授权不变', async () => {
    await db.pool.query(SQL);
    await db.pool.query(SQL);
    const p = await db.pool.query(
      `select policyname from pg_policies where tablename in ('guestbook_entries','friend_links') order by 1`,
    );
    expect(p.rows.map((r) => r.policyname)).toEqual(['friend_links_read', 'guestbook_read']);
    const g = await db.pool.query(
      `select column_name from information_schema.column_privileges
        where table_name = 'friend_links' and grantee = 'anon' and privilege_type = 'SELECT' order by 1`,
    );
    expect(g.rows.map((r) => r.column_name)).not.toContain('contact');
  });
});
