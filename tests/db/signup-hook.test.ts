/**
 * 0007 注册钩子：服务端（src/lib/server/turnstile.ts，Node HMAC）签发的票据，
 * 必须能被数据库函数（pgcrypto HMAC）验证——两边算法一致是这个防线成立的前提。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSignupTicket } from '@/lib/server/turnstile';
import { freshDb } from './setup';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb('hook', { seed: false });
}, 60_000);
afterAll(async () => db?.close());

const event = (email: string, meta: Record<string, unknown> = {}, provider = 'email') => ({
  metadata: { name: 'before-user-created', ip_address: '127.0.0.1' },
  user: { email, app_metadata: { provider, providers: [provider] }, user_metadata: meta },
});
const hook = async (e: unknown) =>
  (await db.pool.query(`select public.az_hook_before_user_created($1::jsonb) as r`, [JSON.stringify(e)]))
    .rows[0].r;

describe('az_hook_before_user_created', () => {
  it('未配置密钥时放行一切（安全的默认）', async () => {
    expect(await hook(event('a@x.io'))).toEqual({});
  });
  describe('配置密钥后', () => {
    const SECRET = 'k'.repeat(64);
    beforeAll(async () => {
      await db.pool.query(
        `insert into private.app_settings (key, value) values ('signup_ticket_secret', $1)`,
        [SECRET],
      );
    });
    it('Node 签发的票据被数据库接受（邮箱大小写不敏感）', async () => {
      const t = makeSignupTicket(SECRET, 'Alice@Example.com');
      expect(await hook(event('alice@example.com', { signup_ticket: t }))).toEqual({});
    });
    it('没有票据 / 篡改 / 换邮箱 / 过期 / 别的密钥 → 403', async () => {
      const now = Math.floor(Date.now() / 1000);
      const cases = [
        {},
        { signup_ticket: 'garbage' },
        { signup_ticket: makeSignupTicket(SECRET, 'other@example.com') },
        { signup_ticket: makeSignupTicket(SECRET, 'alice@example.com', now - 3600) },
        { signup_ticket: makeSignupTicket('wrong', 'alice@example.com') },
      ];
      for (const meta of cases) {
        const r = await hook(event('alice@example.com', meta));
        expect(r.error?.http_code, JSON.stringify(meta)).toBe(403);
      }
    });
    it('第三方登录（GitHub / Google）不需要票据', async () => {
      expect(await hook(event('g@x.io', {}, 'github'))).toEqual({});
      expect(await hook(event('g@x.io', {}, 'google'))).toEqual({});
    });
    it('API 角色不能调用钩子，也读不到 private 里的密钥', async () => {
      const c = await db.pool.connect();
      try {
        await c.query('begin; set local role authenticated');
        await expect(c.query(`select public.az_hook_before_user_created('{}')`)).rejects.toThrow(
          /permission denied/,
        );
        await c.query('rollback; begin; set local role anon');
        await expect(c.query(`select * from private.app_settings`)).rejects.toThrow(/permission denied/);
        await c.query('rollback');
      } finally {
        c.release();
      }
    });
  });
});
