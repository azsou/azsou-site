import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAuth, memoryStore, type Session } from '@/lib/data';

type Call = { url: string; method: string; headers: Record<string, string> };

const user = {
  id: 'u1',
  email: 'a@example.com',
  email_confirmed_at: '2026-10-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: { name: 'Alice' },
};

const signedIn = (): Session => ({
  accessToken: 'jwt-1',
  refreshToken: 'r-1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u1', email: 'a@example.com', emailConfirmed: true, provider: 'email', metaName: 'Alice' },
});

function fakeFetch(logoutStatus: number) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(c);
    if (c.method === 'PUT' && c.url.endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify(user), { status: 200 });
    }
    if (c.url.includes('/auth/v1/logout')) {
      return new Response(logoutStatus === 204 ? null : JSON.stringify({ message: 'x' }), {
        status: logoutStatus,
      });
    }
    return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe('改密码后让其他设备登出', () => {
  it('改密成功后带当前令牌调用 logout?scope=others（不影响当前设备）', async () => {
    const { f, calls } = fakeFetch(204);
    const store = memoryStore(signedIn());
    const auth = createSupabaseAuth({ url: 'https://x.supabase.co', key: 'pk', store, fetch: f });
    await auth.updatePassword('newpass123');
    expect(calls[0]).toMatchObject({ method: 'PUT' });
    const out = calls.find((c) => c.url.includes('/auth/v1/logout'));
    expect(out).toBeDefined();
    expect(out?.url).toBe('https://x.supabase.co/auth/v1/logout?scope=others');
    expect(out?.method).toBe('POST');
    expect(out?.headers.Authorization).toBe('Bearer jwt-1');
    expect(store.get()?.accessToken).toBe('jwt-1');
  });

  it('登出其他设备的请求失败时，改密仍算成功、本地会话保留', async () => {
    const { f, calls } = fakeFetch(500);
    const store = memoryStore(signedIn());
    const auth = createSupabaseAuth({ url: 'https://x.supabase.co', key: 'pk', store, fetch: f });
    await expect(auth.updatePassword('newpass123')).resolves.toBeUndefined();
    expect(calls.some((c) => c.url.includes('scope=others'))).toBe(true);
    expect(store.get()?.accessToken).toBe('jwt-1');
  });
});
