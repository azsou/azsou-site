/**
 * I01（a）官方测试密钥回归——**不是**真实链路验收（真实链路见 docs/audits/evidence/batch1/i01/real-acceptance.md，阻塞）。
 *
 * 只用公开的官方测试凭据：
 * - Cloudflare Turnstile 官方测试 secret（真的请求 challenges.cloudflare.com/turnstile/v0/siteverify）：
 *   1x…AA 总是通过、2x…AA 总是失败、3x…AA 总是 timeout-or-duplicate（token 已用过）；浏览器端测试 token XXXX.DUMMY.TOKEN.XXXX。
 *   https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 * - Supabase Auth（GoTrue）官方发布的二进制跑在本地 Postgres 上（tests/db/gotrue.ts），本地测试 JWT 密钥；不连任何 Supabase 云项目。
 * 每条都断言通过与失败两条路径。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { handleGuardedAuth } from '@/lib/server/guarded-auth';
import { TURNSTILE_TEST, verifyTurnstile } from '@/lib/server/turnstile';
import { dbUrl } from './helpers';
import { gotrueBinary, prepareAuthDb, signJwt, startGotrue, type Gotrue } from './gotrue';

const DB = 'i01_gotrue';
const SITE = 'http://127.0.0.1:4821';
const BASE_PORT = Number(process.env.I01_GOTRUE_PORT) || 4840;
const T = TURNSTILE_TEST;

let plain: Gotrue; // 不开验证码（站点 /api/auth 守卫自己校验 Turnstile）
let capPass: Gotrue; // GoTrue 自带验证码 + 官方「总是通过」secret
let capFail: Gotrue; // 官方「总是失败」secret
let capSpent: Gotrue; // 官方「token 已用过」secret

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-client': `c-${Math.random()}`, ...headers },
    body: JSON.stringify(body),
  });
const userCount = async (email: string) => {
  const c = new pg.Client({ connectionString: dbUrl(DB) });
  await c.connect();
  try {
    return (await c.query('select count(*)::int as n from auth.users where email = $1', [email])).rows[0]
      .n as number;
  } finally {
    await c.end();
  }
};
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

beforeAll(async () => {
  const bin = gotrueBinary();
  await prepareAuthDb(DB, bin);
  [plain, capPass, capFail, capSpent] = await Promise.all([
    startGotrue(bin, DB, BASE_PORT),
    startGotrue(bin, DB, BASE_PORT + 1, { captchaSecret: T.secretPass }),
    startGotrue(bin, DB, BASE_PORT + 2, { captchaSecret: T.secretFail }),
    startGotrue(bin, DB, BASE_PORT + 3, { captchaSecret: T.secretSpent }),
  ]);
}, 240_000);

afterAll(async () => {
  await Promise.all([plain, capPass, capFail, capSpent].filter(Boolean).map((g) => g.stop()));
});

describe('I01（a）Cloudflare siteverify + 官方测试 secret（真实请求 Cloudflare）', () => {
  it('总是通过的 secret → success', async () => {
    const r = await verifyTurnstile(T.dummyToken, T.secretPass);
    expect(r.success).toBe(true);
  });
  it('总是失败的 secret → 拒绝（invalid-input-response）', async () => {
    const r = await verifyTurnstile(T.dummyToken, T.secretFail);
    expect(r.success).toBe(false);
    expect(r.codes).toContain('invalid-input-response');
  });
  it('token 已用过的 secret → 拒绝（timeout-or-duplicate）', async () => {
    const r = await verifyTurnstile(T.dummyToken, T.secretSpent);
    expect(r.success).toBe(false);
    expect(r.codes).toContain('timeout-or-duplicate');
  });
  it('空 token → 本地直接拒绝，不请求 Cloudflare', async () => {
    const r = await verifyTurnstile('', T.secretPass);
    expect(r).toEqual({ success: false, codes: ['missing-input-response'] });
  });
});

describe('I01（a）站点 /api/auth 守卫 → 真实 siteverify（官方 secret）→ 本地 GoTrue', () => {
  // Supabase 网关把 /auth/v1/* 转给 GoTrue；本地 GoTrue 没有网关，这里只做同样的路径前缀转换，请求与响应原样
  const gatewayFetch: typeof fetch = (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    return fetch(u.replace(/^http:\/\/gateway\.local\/auth\/v1\//, `${plain.url}/`), init);
  };
  const call = (secret: string, body: Record<string, unknown>) =>
    handleGuardedAuth(
      'signup',
      new Request(`${SITE}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SITE },
        body: JSON.stringify(body),
      }),
      {
        TURNSTILE_SECRET_KEY: secret,
        PUBLIC_SUPABASE_URL: 'http://gateway.local',
        PUBLIC_SUPABASE_KEY: 'local-anon',
      },
      { fetch: gatewayFetch, defaults: { url: 'http://gateway.local', key: 'local-anon' } },
    );

  it('通过：官方通过 secret + 测试 token → GoTrue 建出用户', async () => {
    const email = uniq('guard-ok');
    const res = await call(T.secretPass, {
      email,
      password: 'Passw0rd!x',
      captchaToken: T.dummyToken,
      data: { name: 'I01' },
    });
    expect(res.status).toBe(200);
    expect(await userCount(email)).toBe(1);
  });
  it('失败：官方失败 secret → 400 turnstile_failed，GoTrue 没有收到注册', async () => {
    const email = uniq('guard-fail');
    const res = await call(T.secretFail, { email, password: 'Passw0rd!x', captchaToken: T.dummyToken });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_code: 'turnstile_failed',
      codes: ['invalid-input-response'],
    });
    expect(await userCount(email)).toBe(0);
  });
  it('失败：token 已用过 → 400 turnstile_failed（timeout-or-duplicate）', async () => {
    const email = uniq('guard-spent');
    const res = await call(T.secretSpent, { email, password: 'Passw0rd!x', captchaToken: T.dummyToken });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_code: 'turnstile_failed',
      codes: ['timeout-or-duplicate'],
    });
    expect(await userCount(email)).toBe(0);
  });
  it('失败：没带 token → 400 captcha_failed', async () => {
    const email = uniq('guard-none');
    const res = await call(T.secretPass, { email, password: 'Passw0rd!x' });
    expect(res.status).toBe(400);
    expect(await userCount(email)).toBe(0);
  });
});

describe('I01（a）GoTrue 自带 Turnstile（官方 secret，GoTrue 自己请求 Cloudflare）', () => {
  const signup = (g: Gotrue, email: string, token?: string) =>
    post(g.url, '/signup', {
      email,
      password: 'Passw0rd!x',
      ...(token ? { gotrue_meta_security: { captcha_token: token } } : {}),
    });
  it('通过：总是通过 secret + 测试 token → 200', async () => {
    const email = uniq('cap-ok');
    const r = await signup(capPass, email, T.dummyToken);
    expect(r.status).toBe(200);
    expect(await userCount(email)).toBe(1);
  });
  it('失败：总是失败 secret → 400 captcha_failed', async () => {
    const email = uniq('cap-fail');
    const r = await signup(capFail, email, T.dummyToken);
    expect(r.status).toBe(400);
    expect((await r.json()).error_code).toBe('captcha_failed');
    expect(await userCount(email)).toBe(0);
  });
  it('失败：token 已用过 secret → 400 captcha_failed', async () => {
    const email = uniq('cap-spent');
    const r = await signup(capSpent, email, T.dummyToken);
    expect(r.status).toBe(400);
    expect((await r.json()).error_code).toBe('captcha_failed');
    expect(await userCount(email)).toBe(0);
  });
  it('失败：没带 token → 400 captcha_failed', async () => {
    const email = uniq('cap-none');
    const r = await signup(capPass, email);
    expect(r.status).toBe(400);
    expect((await r.json()).error_code).toBe('captcha_failed');
  });
});

describe('I01（a）GoTrue（本地）：redirect 白名单、一次性链接、过期 / 伪造 / 重放 token', () => {
  const admin = () => ({
    authorization: `Bearer ${signJwt({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 })}`,
  });
  const link = async (email: string, redirect_to: string) => {
    const r = await post(
      plain.url,
      '/admin/generate_link',
      { type: 'magiclink', email, redirect_to },
      admin(),
    );
    expect(r.status).toBe(200);
    return new URL(((await r.json()) as { action_link: string }).action_link);
  };
  let email = '';
  beforeAll(async () => {
    email = uniq('gt');
    expect((await post(plain.url, '/signup', { email, password: 'Passw0rd!x' })).status).toBe(200);
  });

  it('外域 redirect_to 不在白名单 → 链接回落到站点地址；白名单内的回调地址保留', async () => {
    const evil = await link(email, 'https://evil.example/');
    expect(evil.searchParams.get('redirect_to')).toBe(SITE);
    const dot = await link(email, `${SITE}/auth/callback/..//evil.example`);
    expect(new URL(dot.searchParams.get('redirect_to')!, SITE).origin).toBe(SITE);
    const ok = await link(email, `${SITE}/auth/callback/?next=%2Fforum%2F`);
    expect(ok.searchParams.get('redirect_to')).toBe(`${SITE}/auth/callback/?next=%2Fforum%2F`);
  });

  it('魔法链接只能用一次：第一次带会话跳回站点，第二次被拒（不再发 token）', async () => {
    const l = await link(email, `${SITE}/auth/callback/`);
    const first = await fetch(l, { redirect: 'manual' });
    const loc1 = first.headers.get('location') ?? '';
    expect(loc1.startsWith(`${SITE}/auth/callback/`)).toBe(true);
    expect(loc1).toContain('access_token=');
    const second = await fetch(l, { redirect: 'manual' });
    const loc2 = second.headers.get('location') ?? '';
    expect(loc2).not.toContain('access_token=');
    expect(loc2).toMatch(/error/);
  });

  it('密码错误 → 400 invalid_credentials；正确 → 会话', async () => {
    const bad = await post(plain.url, '/token?grant_type=password', { email, password: 'wrong-pass' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe('invalid_credentials');
    const ok = await post(plain.url, '/token?grant_type=password', { email, password: 'Passw0rd!x' });
    expect(ok.status).toBe(200);
  });

  it('refresh token 重放：紧接着重用上一个 → 安全幂等（返回同一个新 token）；轮换后再用旧 token → 拒绝并吊销整条链', async () => {
    const rt = async (refresh_token: string) => {
      const r = await post(plain.url, '/token?grant_type=refresh_token', { refresh_token });
      return { status: r.status, body: (await r.json()) as { refresh_token?: string; error_code?: string } };
    };
    const s0 = (await (
      await post(plain.url, '/token?grant_type=password', { email, password: 'Passw0rd!x' })
    ).json()) as {
      refresh_token: string;
    };
    const r1 = await rt(s0.refresh_token);
    expect(r1.status).toBe(200);
    // GoTrue 对「刚被轮换的上一个 token」做并发保护：返回当前有效的同一个 token，不开新链
    const again = await rt(s0.refresh_token);
    if (again.status === 200) expect(again.body.refresh_token).toBe(r1.body.refresh_token);
    else expect(again.body.error_code).toBe('refresh_token_already_used');
    const r2 = await rt(r1.body.refresh_token!);
    expect(r2.status).toBe(200);
    const stale = await rt(s0.refresh_token);
    expect(stale.status).toBe(400);
    expect(stale.body.error_code).toBe('refresh_token_already_used');
    // 检测到重放后整条链被吊销：连最新的 token 也不能再用
    const after = await rt(r2.body.refresh_token!);
    expect(after.status).toBe(400);
  });

  it('伪造签名 / 过期的 access_token → 401；有效 token → 200', async () => {
    const s = (await (
      await post(plain.url, '/token?grant_type=password', { email, password: 'Passw0rd!x' })
    ).json()) as {
      access_token: string;
      user: { id: string };
    };
    const get = (tok: string) => fetch(`${plain.url}/user`, { headers: { authorization: `Bearer ${tok}` } });
    expect((await get(s.access_token)).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: s.user.id, aud: 'authenticated', role: 'authenticated', iat: now - 7200 };
    // GoTrue：签名正确但已过期 → 403 bad_jwt；签名不对 → 401/403 bad_jwt。两者都不能拿到用户
    const expired = await get(signJwt({ ...claims, exp: now - 3600 }));
    expect([401, 403]).toContain(expired.status);
    expect((await expired.json()).error_code).toBe('bad_jwt');
    const forged = await get(
      signJwt({ ...claims, exp: now + 3600 }, 'forged-secret-forged-secret-forged-000'),
    );
    expect([401, 403]).toContain(forged.status);
    expect((await forged.json()).error_code).toBe('bad_jwt');
  });
});
