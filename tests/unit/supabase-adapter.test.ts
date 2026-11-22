import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  createSupabaseAuth,
  createSupabaseRepository,
  ForbiddenError,
  memoryStore,
  NotSignedInError,
  RateLimitedError,
  ValidationError,
  type Session,
} from '@/lib/data';
import { fromStored, toStored } from '@/lib/data/session';
import { authErrorFrom } from '@/lib/data/supabase-auth';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** 记录请求并按路由返回的假 fetch */
function fakeFetch(routes: [RegExp, (c: Call) => { status?: number; json?: unknown }][]) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    const r = hit ? hit[1](c) : { status: 404, json: { message: 'no route' } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? null), { status });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const URL_ = 'https://x.supabase.co';
const user = {
  id: 'u1',
  email: 'a@example.com',
  email_confirmed_at: '2026-10-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: { name: 'Alice' },
};
const signedIn = (exp = Math.floor(Date.now() / 1000) + 3600): Session => ({
  accessToken: 'jwt-1',
  refreshToken: 'r-1',
  expiresAt: exp,
  user: { id: 'u1', email: 'a@example.com', emailConfirmed: true, provider: 'email', metaName: 'Alice' },
});

describe('session 存储格式与 V72 兼容（az-session-v68）', () => {
  it('V72 写入的会话可以直接读出；写回保持同样字段', () => {
    const v72 = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 123,
      user,
      profile: { display_name: 'Alice' },
    };
    const s = fromStored(v72)!;
    expect(s).toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 123,
      user: { id: 'u1', emailConfirmed: true, metaName: 'Alice' },
    });
    expect(toStored(s, user)).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: 123, user });
    expect(fromStored({ nope: 1 })).toBeNull();
  });
});

describe('Supabase Auth（GoTrue）', () => {
  it('密码登录：保存会话、通知监听者；错误码翻译成中文', async () => {
    const { f, calls } = fakeFetch([
      [
        /token\?grant_type=password/,
        (c) =>
          (c.body as { password: string }).password === 'good'
            ? { json: { access_token: 'jwt', refresh_token: 'r', expires_in: 3600, user } }
            : {
                status: 400,
                json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
              },
      ],
    ]);
    const store = memoryStore();
    const auth = createSupabaseAuth({ url: URL_, key: 'pk', store, fetch: f });
    const seen: unknown[] = [];
    auth.onChange((s) => seen.push(s?.user.id));
    await expect(auth.signIn('a@example.com', 'bad')).rejects.toMatchObject({
      message: '邮箱或密码不正确。',
      code: 'invalid_credentials',
    });
    const s = await auth.signIn(' a@example.com ', 'good');
    expect(s.user).toMatchObject({ id: 'u1', email: 'a@example.com', provider: 'email' });
    expect(store.get()?.accessToken).toBe('jwt');
    expect(seen).toEqual(['u1']);
    expect(calls[1].body).toEqual({ email: 'a@example.com', password: 'good' });
    expect(calls[1].headers.apikey).toBe('pk');
  });

  it('注册走站内 Turnstile 端点（guardedEndpoint）；需要邮箱确认时没有会话', async () => {
    const { f, calls } = fakeFetch([
      [/POST \/api\/auth\/signup/, () => ({ json: { id: 'u2', email: 'b@example.com' } })],
    ]);
    const auth = createSupabaseAuth({
      url: URL_,
      key: 'pk',
      store: memoryStore(),
      fetch: f,
      guardedEndpoint: '/api/auth',
    });
    const r = await auth.signUp({
      email: 'b@example.com',
      password: 'pw123456',
      displayName: '小B',
      captchaToken: 'tok',
      redirectTo: 'https://azsou.com/auth/callback/',
    });
    expect(r).toEqual({ session: null, needsConfirmation: true });
    expect(calls[0].body).toEqual({
      email: 'b@example.com',
      password: 'pw123456',
      data: { name: '小B' },
      captchaToken: 'tok',
      redirectTo: 'https://azsou.com/auth/callback/',
    });
  });

  it('不设 guardedEndpoint 时直连 GoTrue，并带 captcha_token 与 redirect_to', async () => {
    const { f, calls } = fakeFetch([
      [/signup/, () => ({ json: { access_token: 'jwt', refresh_token: 'r', expires_in: 60, user } })],
    ]);
    const auth = createSupabaseAuth({ url: URL_, key: 'pk', store: memoryStore(), fetch: f });
    const r = await auth.signUp({
      email: 'a@example.com',
      password: 'pw123456',
      displayName: 'A',
      captchaToken: 't',
      redirectTo: 'https://e.com/cb/',
    });
    expect(r.needsConfirmation).toBe(false);
    expect(calls[0].url).toBe(
      `${URL_}/auth/v1/signup?redirect_to=${encodeURIComponent('https://e.com/cb/')}`,
    );
    expect(calls[0].body).toMatchObject({ gotrue_meta_security: { captcha_token: 't' } });
  });

  it('access token 快过期时自动刷新；刷新失败（AuthError）则登出', async () => {
    let ok = true;
    const { f } = fakeFetch([
      [
        /grant_type=refresh_token/,
        () =>
          ok
            ? { json: { access_token: 'jwt-2', refresh_token: 'r-2', expires_in: 3600, user } }
            : { status: 400, json: { error_code: 'refresh_token_not_found' } },
      ],
    ]);
    const store = memoryStore(signedIn(Math.floor(Date.now() / 1000) + 10));
    const auth = createSupabaseAuth({ url: URL_, key: 'pk', store, fetch: f });
    expect(await auth.accessToken()).toBe('jwt-2');
    expect(store.get()?.refreshToken).toBe('r-2');
    store.set({ ...store.get()!, expiresAt: 1 });
    ok = false;
    expect(await auth.accessToken()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('OAuth：PKCE challenge 写进跳转地址，回调用 code + verifier 换会话', async () => {
    let verifier: string | null = null;
    const { f, calls } = fakeFetch([
      [
        /grant_type=pkce/,
        () => ({
          json: {
            access_token: 'jwt',
            refresh_token: 'r',
            expires_in: 3600,
            user: { ...user, app_metadata: { provider: 'github' } },
          },
        }),
      ],
    ]);
    const auth = createSupabaseAuth({
      url: URL_,
      key: 'pk',
      store: memoryStore(),
      fetch: f,
      verifierStore: { get: () => verifier, set: (v) => (verifier = v) },
    });
    const u = new URL(await auth.oauthUrl('github', 'https://azsou.com/auth/callback/'));
    expect(u.pathname).toBe('/auth/v1/authorize');
    expect(u.searchParams.get('provider')).toBe('github');
    expect(u.searchParams.get('code_challenge_method')).toBe('s256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const v = verifier;
    const r = await auth.handleCallback(new URL('https://azsou.com/auth/callback/?code=abc'));
    expect(r).toMatchObject({ type: 'oauth', session: { user: { provider: 'github' } } });
    expect(calls[0].body).toEqual({ auth_code: 'abc', code_verifier: v });
    expect(verifier).toBeNull();
  });

  it('邮件确认链接（implicit #access_token）与错误回跳', async () => {
    const { f } = fakeFetch([[/GET .*\/auth\/v1\/user/, () => ({ json: user })]]);
    const auth = createSupabaseAuth({ url: URL_, key: 'pk', store: memoryStore(), fetch: f });
    const ok = await auth.handleCallback(
      new URL(
        'https://azsou.com/auth/callback/#access_token=jwt&refresh_token=r&expires_in=3600&type=signup',
      ),
    );
    expect(ok).toMatchObject({ type: 'signup', session: { accessToken: 'jwt', user: { id: 'u1' } } });
    const rec = await auth.handleCallback(
      new URL('https://azsou.com/auth/callback/#access_token=jwt&refresh_token=r&type=recovery'),
    );
    expect(rec.type).toBe('recovery');
    const bad = await auth.handleCallback(
      new URL(
        'https://azsou.com/auth/callback/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
      ),
    );
    expect(bad).toEqual({ session: null, type: null, error: '链接已失效或已被使用，请重新发送。' });
    const missing = await auth.handleCallback(new URL('https://azsou.com/auth/callback/?code=x'));
    expect(missing.error).toContain('同一个浏览器');
  });

  it('改密码需要会话；登出即使网络失败也清掉本地会话', async () => {
    const { f, calls } = fakeFetch([
      [/PUT .*\/user/, () => ({ json: user })],
      [/logout/, () => ({ status: 500 })],
    ]);
    const store = memoryStore();
    const auth = createSupabaseAuth({ url: URL_, key: 'pk', store, fetch: f });
    await expect(auth.updatePassword('newpass123')).rejects.toBeInstanceOf(AuthError);
    store.set(signedIn());
    await auth.updatePassword('newpass123');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      body: { password: 'newpass123' },
      headers: { Authorization: 'Bearer jwt-1' },
    });
    await auth.signOut();
    expect(store.get()).toBeNull();
  });

  it('错误翻译：英文消息兜底', () => {
    expect(authErrorFrom(400, { msg: 'User already registered' }).message).toContain('已经注册');
    expect(authErrorFrom(429, {}).message).toContain('太频繁');
    expect(authErrorFrom(422, { error_code: 'weak_password' }).message).toContain('至少 8 位');
  });
});

describe('Supabase 仓储写入', () => {
  const repoWith = (routes: Parameters<typeof fakeFetch>[0], session: Session | null = signedIn()) => {
    const { f, calls } = fakeFetch(routes);
    return {
      repo: createSupabaseRepository({ url: URL_, key: 'pk', fetch: f, store: memoryStore(session) }),
      calls,
    };
  };
  const threadRow = {
    id: 't1',
    cat: '技术交流',
    title: 'T',
    body: 'B',
    author: 'u1',
    pinned: false,
    locked: false,
    featured: false,
    published: true,
    created_at: '2026-10-24T00:00:00Z',
    edited_at: null,
    profiles: { display_name: 'Alice' },
  };

  it('发主题：中文分类名、作者 = 当前用户、带用户 JWT、return=representation', async () => {
    const { repo, calls } = repoWith([[/POST .*forum_threads/, () => ({ status: 201, json: [threadRow] })]]);
    const t = await repo.forum.createThread({ category: 'tech', title: ' T ', body: 'B' });
    expect(t).toMatchObject({ id: 't1', category: 'tech', author: { name: 'Alice' } });
    expect(calls[0].body).toEqual({ cat: '技术交流', title: 'T', body: 'B', author: 'u1' });
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer jwt-1',
      Prefer: 'return=representation',
    });
  });

  it('未登录写入 → NotSignedInError（不发请求）', async () => {
    const { repo, calls } = repoWith([], null);
    await expect(repo.comments.create('article:x', 'hi')).rejects.toBeInstanceOf(NotSignedInError);
    expect(calls).toEqual([]);
  });

  it('数据库错误映射：PT429 → 限流；42501 中文原因透传；RLS 0 行 → Forbidden；23505 → 重复', async () => {
    const { repo } = repoWith([
      [
        /POST .*comments/,
        () => ({
          status: 429,
          json: { code: 'PT429', message: 'rate_limited', hint: '操作太频繁，请稍后再试。' },
        }),
      ],
      [
        /PATCH .*forum_threads/,
        () => ({ status: 403, json: { code: '42501', message: '主题已锁定，不能编辑' } }),
      ],
      [/DELETE .*forum_replies/, () => ({ json: [] })],
      [/POST .*reports/, () => ({ status: 409, json: { code: '23505', message: 'duplicate key' } })],
    ]);
    await expect(repo.comments.create('article:x', 'hi')).rejects.toBeInstanceOf(RateLimitedError);
    await expect(repo.forum.updateThread('t1', { title: 'x' })).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: '主题已锁定，不能编辑',
    });
    await expect(repo.forum.deleteReply('r1')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repo.reports.create({ targetType: 'thread', targetId: 't1', reason: 'spam' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('生产库未迁移时（列不存在 42703）自动退回 V72 的列', async () => {
    const { repo, calls } = repoWith([
      [
        /forum_threads\?select=id,cat,title,body,author,pinned,locked/,
        () => ({
          status: 400,
          json: { code: '42703', message: 'column forum_threads.locked does not exist' },
        }),
      ],
      [
        /forum_threads\?select=id,cat,title,body,author,pinned,published/,
        () => ({ json: [{ ...threadRow, locked: undefined }] }),
      ],
    ]);
    const list = await repo.forum.listThreads();
    expect(list.map((t) => t.id)).toEqual(['t1']);
    expect(calls).toHaveLength(2);
  });

  it('点赞重复不报错；点赞汇总补齐 0；通知列表用外键提示嵌入 actor', async () => {
    const { repo, calls } = repoWith([
      [/POST .*\/likes/, () => ({ status: 409, json: { code: '23505' } })],
      [/rpc\/like_summary/, () => ({ json: [{ target_id: 'a', likes: 3, liked: true }] })],
      [
        /notifications\?select=/,
        () => ({
          json: [
            {
              id: 7,
              kind: 'reply',
              excerpt: 'hi',
              read_at: null,
              created_at: 'x',
              thread_key: 't1',
              target_type: 'reply',
              target_id: 'r1',
              actor: { display_name: 'Bob' },
            },
          ],
        }),
      ],
      [/rpc\/unread_notification_count/, () => ({ json: 4 })],
      [/rpc\/mark_notifications_read/, () => ({ json: 2 })],
    ]);
    await repo.forum.like('thread', 'a');
    expect(await repo.forum.likeSummary('thread', ['a', 'b'])).toEqual({
      a: { likes: 3, liked: true },
      b: { likes: 0, liked: false },
    });
    expect((await repo.notifications.list())[0]).toEqual({
      id: 7,
      kind: 'reply',
      actorName: 'Bob',
      threadKey: 't1',
      targetType: 'reply',
      targetId: 'r1',
      excerpt: 'hi',
      read: false,
      createdAt: 'x',
    });
    expect(calls.find((c) => c.url.includes('notifications?'))?.url).toContain(
      'actor:profiles!notifications_actor_fkey(display_name)',
    );
    expect(await repo.notifications.unreadCount()).toBe(4);
    expect(await repo.notifications.markRead([1, 2])).toBe(2);
    expect(calls.at(-1)?.body).toEqual({ p_ids: [1, 2] });
  });

  it('改昵称：PATCH 自己的资料', async () => {
    const { repo, calls } = repoWith([
      [
        /PATCH .*profiles\?id=eq\.u1/,
        () => ({
          json: [{ id: 'u1', display_name: 'New', role: 'moderator', banned: false, created_at: 'x' }],
        }),
      ],
    ]);
    expect(await repo.profiles.updateDisplayName(' New ')).toEqual({
      id: 'u1',
      displayName: 'New',
      role: 'moderator',
      banned: false,
      createdAt: 'x',
    });
    expect(calls[0].body).toEqual({ display_name: 'New' });
  });
});
