import { describe, expect, it, vi } from 'vitest';
import { handleGuardedAuth } from '@/lib/server/guarded-auth';
import { handleCommunitySubmit } from '@/lib/server/community-submit';
import { handleSubscribe } from '@/lib/server/subscribe';
import { SITEVERIFY_URL, TURNSTILE_TEST } from '@/lib/server/turnstile';

/**
 * PR #10 上线后线上仍然报「来源不正确」：函数看到的请求地址可能不是浏览器访问的主机。
 * 对外主机要按代理头取（X-Forwarded-Host 优先，其次 Host，最后才是请求地址），
 * 回调链接也用这个公开主机；跨站 Origin、https→http 降级仍然拒绝。
 * 对不上时，提示里临时带上双方看到的值，方便定位。
 */
const defaults = { url: 'https://sb.example.co', key: 'pk' };
const PUBLIC = 'https://azsou.com';
const EVIL = 'https://evil.example';
const INTERNAL = 'http://azsou-site-abc123.vercel.app/api/x';

const signupBody = {
  email: 'a@example.com',
  password: 'pw123456',
  captchaToken: TURNSTILE_TEST.dummyToken,
};

const post = (headers: Record<string, string>, body: unknown = signupBody) =>
  new Request(INTERNAL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

const signup = (f: typeof fetch, headers: Record<string, string>) =>
  handleGuardedAuth('signup', post(headers), {}, { fetch: f, defaults });
const community = (f: typeof fetch, headers: Record<string, string>) =>
  handleCommunitySubmit('guestbook', post(headers, {}), {}, { fetch: f, defaults });
const subscribe = (f: typeof fetch, headers: Record<string, string>) =>
  handleSubscribe(post(headers, {}), {}, { fetch: f, defaults, mailer: null });

describe('同源检查按代理头取公开主机', () => {
  it('请求地址是内部主机、X-Forwarded-Host 是 azsou.com：放行，回调链接用公开主机', async () => {
    const { f, calls } = upstream();
    const res = await signup(f, { origin: PUBLIC, 'x-forwarded-host': 'azsou.com' });
    expect(res.status).toBe(200);
    const gotrue = calls.find((u) => u.includes('/auth/v1/signup'));
    expect(gotrue).toContain(encodeURIComponent(`${PUBLIC}/auth/callback/`));
  });

  it('只有 Host 头是 azsou.com 也放行', async () => {
    const { f } = upstream();
    const res = await signup(f, { origin: PUBLIC, host: 'azsou.com' });
    expect(res.status).toBe(200);
  });

  it('X-Forwarded-Host 带多个值时取第一个', async () => {
    const { f } = upstream();
    const res = await signup(f, { origin: PUBLIC, 'x-forwarded-host': 'azsou.com, edge.internal' });
    expect(res.status).toBe(200);
  });

  it('留言 / 订阅入口同样按代理头放行', async () => {
    const { f } = upstream();
    const headers = { origin: PUBLIC, 'x-forwarded-host': 'azsou.com' };
    const g = await community(f, headers);
    expect((await g.json()).error_code).not.toBe('bad_origin');
    const s = await subscribe(f, headers);
    expect((await s.json()).error_code).not.toBe('bad_origin');
  });

  it('跨站 Origin 即使代理头是 azsou.com 也拒绝，并带上诊断信息', async () => {
    const { f } = upstream();
    const res = await signup(f, { origin: EVIL, 'x-forwarded-host': 'azsou.com' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error_code).toBe('bad_origin');
    expect(body.msg).toContain('来源不正确');
    expect(body.msg).toContain('origin=https://evil.example');
    expect(body.msg).toContain('xfh=azsou.com');
  });

  it('https→http 降级（Origin 为 http://azsou.com）仍然拒绝', async () => {
    const { f } = upstream();
    const res = await signup(f, { origin: 'http://azsou.com', 'x-forwarded-host': 'azsou.com' });
    expect(res.status).toBe(403);
  });

  it('诊断信息只含被清洗过的头，不会带出换行或引号', async () => {
    const { f } = upstream();
    const res = await signup(f, { origin: 'https://a"b<c>.example', 'x-forwarded-host': 'azsou.com' });
    const { msg } = await res.json();
    expect(msg).not.toMatch(/["<>\n]/);
  });
});
