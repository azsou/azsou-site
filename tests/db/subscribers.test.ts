/**
 * T7.8（迁移 0016）：邮件订阅（双重确认）。
 *  - 任何角色都不能直接读写 subscribers（连管理员也只能看数量）；
 *  - subscribe_request 需要有效票据（与 0015 同一套）、校验格式、只存令牌的 sha256；
 *  - 已订阅的邮箱再提交 send = false；10 分钟内不重复发信；限流；
 *  - 确认：令牌正确且未过期 → confirmed，令牌用过即失效；过期 → expired；
 *  - 退订：幂等；退订后可以重新订阅；
 *  - 可重复执行。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, run, verdict } from './helpers';
import { U } from './fixtures';
import { freshDb } from './setup';
import { clientHash, makeCommunityTicket } from '../../src/lib/server/community-submit';
import { subscribePayload } from '../../src/lib/subscribe-form';

let db: Awaited<ReturnType<typeof freshDb>>;
const anon = { role: 'anon' } as const;
const as = (uid: string) => ({ role: 'authenticated', uid }) as const;
const SECRET = 'db-test-community-secret';
const SQL = readFileSync(join(MIGRATIONS_DIR, '0016_subscribers.sql'), 'utf8');
let n = 0;
const ip = () => `192.0.2.${++n}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tok = () => randomBytes(32).toString('hex');
const ticket = (email: string, lang = 'zh', client = clientHash(SECRET, ip())) =>
  makeCommunityTicket(SECRET, 'subscribe', subscribePayload({ email, lang: lang as 'zh' }), client);
const REQ = `select public.subscribe_request($1, $2, $3, $4, $5) as r`;
const request = (
  email: string,
  confirm = tok(),
  unsub = tok(),
  lang = 'zh',
  t = ticket(email.toLowerCase(), lang),
) => run(db.pool, anon, REQ, [email, lang, sha(confirm), sha(unsub), t], { commit: true });
const confirmRpc = (t: string) =>
  run(db.pool, anon, `select public.subscribe_confirm($1) as r`, [t], { commit: true });
const unsubRpc = (t: string) =>
  run(db.pool, anon, `select public.subscribe_unsubscribe($1) as r`, [t], { commit: true });
const val = (o: Awaited<ReturnType<typeof run>>) =>
  o.ok ? (o.rows[0].r as Record<string, unknown>) : o.code;

beforeAll(async () => {
  db = await freshDb('subscribers');
  await db.pool.query(
    `insert into private.app_settings (key, value) values ('community_ticket_secret', $1)
     on conflict (key) do update set value = excluded.value`,
    [SECRET],
  );
});
afterAll(async () => {
  await db?.close();
});

describe('0016 订阅表：没有任何直接读写', () => {
  it('anon / 用户 / 版主 / 管理员 都不能 select / insert / update / delete', async () => {
    for (const who of [anon, as(U.alice), as(U.mia), as(U.ada)]) {
      expect(verdict(await run(db.pool, who, `select email from public.subscribers`))).toBe('deny');
      expect(
        verdict(
          await run(
            db.pool,
            who,
            `insert into public.subscribers (email, unsubscribe_hash) values ('x@example.com', repeat('a', 64))`,
          ),
        ),
      ).toBe('deny');
      expect(verdict(await run(db.pool, who, `update public.subscribers set status = 'confirmed'`))).toBe(
        'deny',
      );
      expect(verdict(await run(db.pool, who, `delete from public.subscribers`))).toBe('deny');
    }
  });
});

describe('0016 订阅 → 确认 → 退订', () => {
  it('新邮箱：send = true，存的是 sha256，状态 pending', async () => {
    const c = tok();
    const u = tok();
    expect(val(await request('Alice@Example.com', c, u))).toMatchObject({ send: true });
    const row = (await db.pool.query(`select * from public.subscribers where email = 'alice@example.com'`))
      .rows[0];
    expect(row.status).toBe('pending');
    expect(row.confirm_hash).toBe(sha(c));
    expect(row.unsubscribe_hash).toBe(sha(u));
    expect(JSON.stringify(row)).not.toContain(c);
    expect(JSON.stringify(row)).not.toContain(u);
  });
  it('没有票据 / 内容被改 / 格式错误 被拒', async () => {
    const c = sha(tok());
    expect(val(await run(db.pool, anon, REQ, ['b@example.com', 'zh', c, c, '']))).toBe('42501');
    expect(
      val(await run(db.pool, anon, REQ, ['b@example.com', 'zh', c, c, ticket('other@example.com')])),
    ).toBe('42501');
    expect(val(await run(db.pool, anon, REQ, ['not-an-email', 'zh', c, c, ticket('not-an-email')]))).toBe(
      '22023',
    );
    expect(
      val(await run(db.pool, anon, REQ, ['b@example.com', 'fr', c, c, ticket('b@example.com', 'fr')])),
    ).toBe('22023');
    expect(
      val(await run(db.pool, anon, REQ, ['b@example.com', 'zh', 'plain', c, ticket('b@example.com')])),
    ).toBe('22023');
  });
  it('10 分钟内重复提交不再发信；确认后再提交也不发信（不泄露是否已订阅）', async () => {
    const c = tok();
    expect(val(await request('carol@example.com', c))).toMatchObject({ send: true });
    expect(val(await request('carol@example.com'))).toMatchObject({ send: false });
    // 重复提交没有覆盖令牌：第一封信里的链接仍然有效
    expect(val(await confirmRpc(c))).toMatchObject({ status: 'confirmed', lang: 'zh' });
    expect(val(await confirmRpc(c))).toMatchObject({ status: 'invalid' });
    await db.pool.query(
      `update public.subscribers set last_sent_at = now() - interval '1 hour' where email = 'carol@example.com'`,
    );
    expect(val(await request('carol@example.com'))).toMatchObject({ send: false });
    const s = (await db.pool.query(`select status from public.subscribers where email = 'carol@example.com'`))
      .rows[0];
    expect(s.status).toBe('confirmed');
  });
  it('确认链接 48 小时过期；格式不对的令牌是 invalid', async () => {
    const c = tok();
    await request('dave@example.com', c);
    await db.pool.query(
      `update public.subscribers set confirm_expires_at = now() - interval '1 minute' where email = 'dave@example.com'`,
    );
    expect(val(await confirmRpc(c))).toMatchObject({ status: 'expired' });
    expect(val(await confirmRpc('zz'))).toMatchObject({ status: 'invalid' });
    expect(val(await confirmRpc(tok()))).toMatchObject({ status: 'invalid' });
  });
  it('退订幂等；退订后可以重新订阅（新的确认信）', async () => {
    const c = tok();
    const u = tok();
    await request('erin@example.com', c, u, 'en');
    expect(val(await confirmRpc(c))).toMatchObject({ status: 'confirmed', lang: 'en' });
    expect(val(await unsubRpc(u))).toMatchObject({ status: 'unsubscribed' });
    expect(val(await unsubRpc(u))).toMatchObject({ status: 'unsubscribed' });
    expect(val(await unsubRpc(tok()))).toMatchObject({ status: 'invalid' });
    const c2 = tok();
    expect(val(await request('erin@example.com', c2, u, 'en'))).toMatchObject({ send: true });
    expect(val(await confirmRpc(c2))).toMatchObject({ status: 'confirmed' });
  });
  it('同一访客每小时最多 3 次', async () => {
    const client = clientHash(SECRET, '203.0.113.77');
    const codes: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      const e = `limit${i}@example.com`;
      codes.push(val(await request(e, tok(), tok(), 'zh', ticket(e, 'zh', client))));
    }
    expect(codes.slice(0, 3)).toEqual([{ send: true }, { send: true }, { send: true }]);
    expect(codes[3]).toBe('PT429');
  });
});

describe('0016 后台只有数量', () => {
  it('管理员看到按状态 × 语言的数量，版主 / 普通用户 / anon 被拒', async () => {
    const r = await run(db.pool, as(U.ada), `select * from public.admin_subscriber_counts()`);
    expect(r.ok).toBe(true);
    const rows = r.ok ? r.rows : [];
    expect(Object.keys(rows[0]).sort()).toEqual(['lang', 'n', 'status']);
    expect(rows.find((x) => x.status === 'confirmed' && x.lang === 'zh')?.n).toBeDefined();
    for (const who of [as(U.mia), as(U.alice)])
      expect(val(await run(db.pool, who, `select * from public.admin_subscriber_counts()`))).toBe('42501');
    expect(verdict(await run(db.pool, anon, `select * from public.admin_subscriber_counts()`))).toBe('deny');
  });
  it('可重复执行', async () => {
    await db.pool.query(SQL);
    await db.pool.query(SQL);
    expect(
      (await db.pool.query(`select count(*)::int as n from public.subscribers`)).rows[0].n,
    ).toBeGreaterThan(3);
  });
});
