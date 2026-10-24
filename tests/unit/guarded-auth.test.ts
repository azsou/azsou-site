import { describe, expect, it, vi } from 'vitest';
import { handleGuardedAuth, resolveSecret, safeRedirect } from '@/lib/server/guarded-auth';
import {
  checkSignupTicket,
  makeSignupTicket,
  SITEVERIFY_URL,
  TURNSTILE_TEST,
  verifyTurnstile,
} from '@/lib/server/turnstile';

const ORIGIN = 'https://azsou.com';
const defaults = { url: 'https://sb.example.co', key: 'pk' };
const req = (action: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/auth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

/** siteverify 与 GoTrue 的假实现 */
function upstream(turnstileOk = true) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: String(init.body), headers: (init.headers ?? {}) as Record<string, string> });
    if (url === SITEVERIFY_URL) {
      const p = new URLSearchParams(String(init.body));
      const ok = turnstileOk && p.get('secret') === TURNSTILE_TEST.secretPass;
      return Response.json({ success: ok, 'error-codes': ok ? [] : ['invalid-input-secret'] });
    }
    return Response.json({ id: 'u1', email: 'a@example.com' });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Turnstile 服务端校验', () => {
  it('把 secret / token / remoteip 以表单提交给 siteverify', async () => {
    const { f, calls } = upstream();
    const r = await verifyTurnstile('tok', TURNSTILE_TEST.secretPass, { ip: '1.2.3.4', fetch: f });
    expect(r.success).toBe(true);
    const p = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(p)).toEqual({
      secret: TURNSTILE_TEST.secretPass,
      response: 'tok',
      remoteip: '1.2.3.4',
    });
  });
  it('空 token / 网络错误 → 失败', async () => {
    expect((await verifyTurnstile('', 's')).success).toBe(false);
    const boom = (async () => {
      throw new TypeError('down');
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile('t', 's', { fetch: boom })).toMatchObject({ success: false });
  });
  it('密钥选择：有真实密钥用真实的；本地用测试密钥；部署环境缺密钥 → null（拒绝服务）', () => {
    expect(resolveSecret({ TURNSTILE_SECRET_KEY: 'real' })).toBe('real');
    expect(resolveSecret({})).toBe(TURNSTILE_TEST.secretPass);
    expect(resolveSecret({ VERCEL_ENV: 'production' })).toBeNull();
    expect(resolveSecret({ VERCEL_ENV: 'preview' })).toBeNull();
    expect(resolveSecret({ VERCEL_ENV: 'preview', TURNSTILE_ALLOW_TEST_KEYS: '1' })).toBe(
      TURNSTILE_TEST.secretPass,
    );
  });
});

describe('注册票据（与 db/migrations/0007 的 SQL 校验同一算法）', () => {
  it('签发 / 校验 / 过期 / 篡改', () => {
    const now = 1_800_000_000;
    const t = makeSignupTicket('s3cret', ' A@Example.com ', now);
    expect(t).toMatch(/^1800000000\.[0-9a-f]{64}$/);
    expect(checkSignupTicket('s3cret', 'a@example.com', t, now + 60)).toBe(true);
    expect(checkSignupTicket('s3cret', 'a@example.com', t, now + 3600)).toBe(false);
    expect(checkSignupTicket('other', 'a@example.com', t, now)).toBe(false);
    expect(checkSignupTicket('s3cret', 'b@example.com', t, now)).toBe(false);
    expect(checkSignupTicket('s3cret', 'a@example.com', 'x.y', now)).toBe(false);
  });
});

describe('/api/auth/[action]', () => {
  it('signup：Turnstile 通过后转发 GoTrue，带 redirect_to 与 signup_ticket', async () => {
    const { f, calls } = upstream();
    const res = await handleGuardedAuth(
      'signup',
      req('signup', {
        email: 'a@example.com',
        password: 'pw123456',
        data: { name: ' 小A ' },
        captchaToken: TURNSTILE_TEST.dummyToken,
        redirectTo: `${ORIGIN}/auth/callback/`,
      }),
      { SIGNUP_TICKET_SECRET: 'tk' },
      { fetch: f, defaults, now: () => 1_800_000_000 },
      '9.9.9.9',
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      SITEVERIFY_URL,
      `https://sb.example.co/auth/v1/signup?redirect_to=${encodeURIComponent(`${ORIGIN}/auth/callback/`)}`,
    ]);
    const sent = JSON.parse(calls[1].body);
    expect(sent).toEqual({
      email: 'a@example.com',
      password: 'pw123456',
      data: { name: '小A', signup_ticket: makeSignupTicket('tk', 'a@example.com', 1_800_000_000) },
    });
    expect(calls[1].headers.apikey).toBe('pk');
    expect(new URLSearchParams(calls[0].body).get('remoteip')).toBe('9.9.9.9');
  });
  it('Turnstile 失败 → 400 turnstile_failed，不转发', async () => {
    const { f, calls } = upstream(false);
    const res = await handleGuardedAuth(
      'recover',
      req('recover', { email: 'a@example.com', captchaToken: 'x' }),
      {},
      { fetch: f, defaults },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: 'turnstile_failed' });
    expect(calls).toHaveLength(1);
  });
  it('生产环境没有配置密钥 → 503（失败即关闭）', async () => {
    const { f, calls } = upstream();
    const res = await handleGuardedAuth(
      'signup',
      req('signup', { email: 'a@example.com', password: 'pw123456', captchaToken: 't' }),
      { VERCEL_ENV: 'production' },
      { fetch: f, defaults },
    );
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it('输入校验：未知动作 / 非 POST / 跨站 Origin / 邮箱格式 / 缺 token / 弱密码', async () => {
    const { f } = upstream();
    const d = { fetch: f, defaults };
    expect((await handleGuardedAuth('nope', req('nope', {}), {}, d)).status).toBe(404);
    expect((await handleGuardedAuth('signup', new Request(`${ORIGIN}/api/auth/signup`), {}, d)).status).toBe(
      405,
    );
    expect(
      (
        await handleGuardedAuth(
          'signup',
          req('signup', { email: 'a@example.com' }, { origin: 'https://evil.example' }),
          {},
          d,
        )
      ).status,
    ).toBe(403);
    expect((await handleGuardedAuth('signup', req('signup', { email: 'nope' }), {}, d)).status).toBe(400);
    expect(
      await (await handleGuardedAuth('signup', req('signup', { email: 'a@example.com' }), {}, d)).json(),
    ).toMatchObject({ error_code: 'captcha_failed' });
    expect(
      await (
        await handleGuardedAuth(
          'signup',
          req('signup', { email: 'a@example.com', password: '123', captchaToken: 't' }),
          {},
          d,
        )
      ).json(),
    ).toMatchObject({ error_code: 'weak_password' });
  });
  it('resend：转发 {type: signup}；redirect_to 只能是本站 /auth/callback/', async () => {
    const { f, calls } = upstream();
    await handleGuardedAuth(
      'resend',
      req('resend', { email: 'a@example.com', captchaToken: 't', redirectTo: 'https://evil.example/x' }),
      {},
      { fetch: f, defaults },
    );
    expect(calls[1].url).toBe(
      `https://sb.example.co/auth/v1/resend?redirect_to=${encodeURIComponent(`${ORIGIN}/auth/callback/`)}`,
    );
    expect(JSON.parse(calls[1].body)).toEqual({ type: 'signup', email: 'a@example.com' });
    expect(safeRedirect(`${ORIGIN}/auth/callback/?next=/settings/`, ORIGIN)).toBe(
      `${ORIGIN}/auth/callback/?next=/settings/`,
    );
    expect(safeRedirect(`${ORIGIN}/admin/`, ORIGIN)).toBe(`${ORIGIN}/auth/callback/`);
  });
});
