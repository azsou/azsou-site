import { describe, expect, it, vi } from 'vitest';
import { handleGuardedAuth } from '@/lib/server/guarded-auth';
import { handleCommunitySubmit } from '@/lib/server/community-submit';
import { handleSubscribe } from '@/lib/server/subscribe';
import { SITEVERIFY_URL, TURNSTILE_TEST } from '@/lib/server/turnstile';

/**
 * 线上（Vercel 边缘代理之后）函数看到的 request.url 是 http://azsou.com/...，
 * 浏览器发来的 Origin 却是 https://azsou.com。同源检查必须按公开地址（https）比较，
 * 同时仍然拦截跨站 Origin 与 https→http 降级。
 */
const defaults = { url: 'https://sb.example.co', key: 'pk' };
const PUBLIC = 'https://azsou.com';

const post = (url: string, body: unknown, origin?: string) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

function upstream() {
  const calls: string[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === SITEVERIFY_URL) return Response.json({ success: true, 'error-codes': [] });
    if (url.includes('/rest/v1/site_content')) return Response.json([]);
    return Response.json({ id: 'u1' });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const signupBody = {
  email: 'a@example.com',
  password: 'pw123456',
  captchaToken: TURNSTILE_TEST.dummyToken,
};

describe('反向代理之后的同源检查（线上 http 请求地址 + https Origin）', () => {
  it('signup：请求地址 http://azsou.com、Origin https://azsou.com → 放行，回调链接是 https', async () => {
    const { f, calls } = upstream();
    const res = await handleGuardedAuth(
      'signup',
      post('http://azsou.com/api/auth/signup', signupBody, PUBLIC),
      {},
      { fetch: f, defaults },
    );
    expect(res.status).toBe(200);
    const gotrue = calls.find((u) => u.includes('/auth/v1/signup'))!;
    expect(gotrue).toBe(
      `https://sb.example.co/auth/v1/signup?redirect_to=${encodeURIComponent(`${PUBLIC}/auth/callback/`)}`,
    );
  });

  it('guestbook / subscribe：同样不再返回 bad_origin', async () => {
    const { f } = upstream();
    const g = await handleCommunitySubmit(
      'guestbook',
      post('http://azsou.com/api/submit/guestbook', {}, PUBLIC),
      {},
      { fetch: f, defaults },
    );
    expect((await g.json()).error_code).not.toBe('bad_origin');
    const s = await handleSubscribe(
      post('http://azsou.com/api/subscribe', {}, PUBLIC),
      {},
      { fetch: f, defaults, mailer: null },
    );
    expect((await s.json()).error_code).not.toBe('bad_origin');
  });

  it('跨站 Origin 仍然 403 bad_origin（三个入口）', async () => {
    const { f } = upstream();
    const evil = 'https://evil.example';
    const a = await handleGuardedAuth(
      'signup',
      post('http://azsou.com/api/auth/signup', signupBody, evil),
      {},
      { fetch: f, defaults },
    );
    expect(a.status).toBe(403);
    expect((await a.json()).error_code).toBe('bad_origin');
    const g = await handleCommunitySubmit(
      'guestbook',
      post('http://azsou.com/api/submit/guestbook', {}, evil),
      {},
      { fetch: f, defaults },
    );
    expect(g.status).toBe(403);
    const s = await handleSubscribe(
      post('http://azsou.com/api/subscribe', {}, evil),
      {},
      { fetch: f, defaults, mailer: null },
    );
    expect(s.status).toBe(403);
  });

  it('https→http 降级（Origin 为 http://azsou.com）仍然拒绝', async () => {
    const { f } = upstream();
    const res = await handleGuardedAuth(
      'signup',
      post('http://azsou.com/api/auth/signup', signupBody, 'http://azsou.com'),
      {},
      { fetch: f, defaults },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('bad_origin');
  });

  it('本地开发（127.0.0.1 / localhost 的 http）Origin 与请求地址一致时照常放行', async () => {
    for (const base of ['http://127.0.0.1:4321', 'http://localhost:4321']) {
      const { f, calls } = upstream();
      const res = await handleGuardedAuth(
        'signup',
        post(`${base}/api/auth/signup`, signupBody, base),
        {},
        { fetch: f, defaults },
      );
      expect(res.status, base).toBe(200);
      expect(calls.find((u) => u.includes('/auth/v1/signup')), base).toContain(
        encodeURIComponent(`${base}/auth/callback/`),
      );
    }
  });

  it('没有 Origin 头（同源 GET 之外的服务端调用）仍按原逻辑放行', async () => {
    const { f } = upstream();
    const res = await handleGuardedAuth(
      'signup',
      post('http://azsou.com/api/auth/signup', signupBody),
      {},
      { fetch: f, defaults },
    );
    expect(res.status).toBe(200);
  });
});
