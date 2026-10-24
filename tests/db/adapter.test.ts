/**
 * Supabase 适配器（src/lib/data/supabase.ts）对真实 PostgREST + 迁移后的库做集成测试：
 * 前端仓储层发出的每一种请求都真的被 PostgREST / RLS / 触发器接受或按预期拒绝。
 * 同时验证：生产库迁移前（baseline），v2 的读取会自动退回 V72 的列，预览站照常可读。
 */
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseRepository } from '@/lib/data/supabase';
import {
  ForbiddenError,
  RateLimitedError,
  ValidationError,
  type AuthProvider,
  type DataRepository,
  type Session,
} from '@/lib/data/types';
import { MIGRATIONS_DIR, SHIM } from './helpers';
import { ANON, BIN, ensureAuthenticator, freePort, startPostgrest, tok } from './postgrest';
import { T, U } from './fixtures';
import { freshDb } from './setup';

/** 用测试 JWT 冒充 GoTrue 会话的最小 AuthProvider */
function fakeAuth(uid: string | null): AuthProvider {
  const session: Session | null = uid
    ? {
        accessToken: tok(uid),
        refreshToken: 'r',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { id: uid, email: null, emailConfirmed: true, provider: 'email' },
      }
    : null;
  const no = async () => {
    throw new Error('not used');
  };
  return {
    getSession: () => session,
    accessToken: async () => session?.accessToken ?? null,
    onChange: () => () => {},
    signUp: no,
    signIn: no,
    signOut: no,
    requestPasswordReset: no,
    updatePassword: no,
    resendConfirmation: no,
    oauthUrl: no,
    handleCallback: no,
  } as AuthProvider;
}

describe.skipIf(!BIN)('Supabase 适配器 × PostgREST', () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let proc: ChildProcess;
  let url: string;
  const as = (who: keyof typeof U | null): DataRepository =>
    createSupabaseRepository({ url, key: ANON, auth: fakeAuth(who ? U[who] : null) });

  beforeAll(async () => {
    await ensureAuthenticator();
    db = await freshDb('adapter');
    const port = freePort();
    proc = await startPostgrest(db.name, port);
    // 适配器拼的是 ${url}/rest/v1/...；本地 PostgREST 没有 /rest/v1 前缀，用一个小代理去掉
    url = `http://127.0.0.1:${port}`;
  }, 60_000);
  afterAll(async () => {
    proc?.kill();
    await db?.close();
  });

  // 去掉 /rest/v1 前缀
  const origFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      origFetch(String(input).replace('/rest/v1/', '/'), init)) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  it('匿名读取：列表（置顶在前）/ 主题 / 回复 / 评论', async () => {
    const repo = as(null);
    const list = await repo.forum.listThreads();
    expect(list[0].pinned).toBe(true);
    expect(list.some((t) => t.id === T.bobHidden)).toBe(false);
    expect((await repo.forum.listThreads({ category: 'announce' })).map((t) => t.id)).toEqual([T.announce]);
    expect((await repo.forum.getThread(T.bobLocked))?.locked).toBe(true);
    expect((await repo.forum.listReplies(T.bob)).length).toBe(5);
    expect((await repo.forum.listReplies('t-announce')).length).toBe(1);
    expect((await repo.comments.list('article:pinyin-initial-search')).length).toBe(5);
    expect((await repo.forum.replyCounts())[T.bob]).toBe(5);
  });

  it('用户：发主题 → 编辑 → 回复（数据库主题与种子主题）→ 评论 → 点赞 → 举报 → 删除', async () => {
    const repo = as('alice');
    const t = await repo.forum.createThread({ category: 'tech', title: '集成测试', body: '正文' });
    expect(t).toMatchObject({ category: 'tech', author: { id: U.alice, name: 'alice' }, pinned: false });
    expect((await repo.forum.updateThread(t.id, { body: '改过' })).editedAt).toBeTruthy();
    const r = await repo.forum.reply(T.bob, '你好');
    expect(r.threadId).toBe(T.bob);
    expect((await repo.forum.reply('t-announce', '种子')).threadId).toBe('t-announce');
    const c = await repo.comments.create('article:x', '评论');
    expect((await repo.comments.update(c.id, '改')).editedAt).toBeTruthy();
    await repo.forum.like('thread', T.ada);
    await repo.forum.like('thread', T.ada); // 重复点赞不报错
    expect((await repo.forum.likeSummary('thread', [T.ada]))[T.ada]).toEqual({ likes: 1, liked: true });
    await repo.forum.unlike('thread', T.ada);
    const rep = await repo.reports.create({
      targetType: 'reply',
      targetId: r.id,
      reason: 'other',
      detail: '测试',
    });
    expect(rep.status).toBe('open');
    await expect(
      repo.reports.create({ targetType: 'reply', targetId: r.id, reason: 'other' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.reports.listMine()).length).toBe(2);
    await repo.comments.remove(c.id);
    await repo.forum.deleteReply(r.id);
    await repo.forum.deleteThread(t.id);
    expect(await repo.forum.getThread(t.id)).toBeNull();
  });

  it('越权：改别人的主题 / 置顶 / 回复锁定主题 / 被封禁发帖 → ForbiddenError（带中文原因）', async () => {
    const alice = as('alice');
    await expect(alice.forum.updateThread(T.bob, { title: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(alice.forum.setThreadFlags(T.alice, { pinned: true })).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: expect.stringContaining('仅版主'),
    });
    await expect(alice.forum.reply(T.bobLocked, 'x')).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: expect.stringContaining('锁定'),
    });
    await expect(alice.forum.reply('00000000-0000-4000-8000-000000000000', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      as('carol').forum.createThread({ category: 'tech', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      alice.forum.createThread({ category: 'announce', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('版主：置顶 / 锁定 / 处理举报；举报人收到通知并可标记已读', async () => {
    const mia = as('mia');
    expect(await mia.forum.setThreadFlags(T.alice, { pinned: true, featured: true })).toMatchObject({
      pinned: true,
      featured: true,
    });
    const open = await mia.reports.listOpen();
    expect(open.length).toBeGreaterThan(0);
    const target = open.find((r) => r.reporter === U.alice)!;
    expect((await mia.reports.resolve(target.id, 'resolved', '已处理')).status).toBe('resolved');
    const alice = as('alice');
    const n = await alice.notifications.list();
    expect(n.some((x) => x.kind === 'report' && x.actorName === 'mia')).toBe(true);
    const unread = await alice.notifications.unreadCount();
    expect(unread).toBeGreaterThan(0);
    expect(await alice.notifications.markRead()).toBe(unread);
    expect(await alice.notifications.unreadCount()).toBe(0);
    // 非版主只能看到自己提交的待处理举报（RLS：reporter = 自己）
    expect((await as('alice').reports.listOpen()).every((r) => r.reporter === U.alice)).toBe(true);
  });

  it('资料：读取 / 改昵称；限流 → RateLimitedError', async () => {
    const bob = as('bob');
    expect((await bob.profiles.me())?.displayName).toBe('bob');
    expect((await bob.profiles.updateDisplayName('Bob B')).displayName).toBe('Bob B');
    let err: unknown;
    try {
      for (let i = 0; i < 8; i++) await bob.comments.create('article:x', `c${i}`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RateLimitedError);
  });
});

describe.skipIf(!BIN)('Supabase 适配器 × 迁移前的生产库结构', () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let proc: ChildProcess;
  let repo: DataRepository;
  const origFetch = globalThis.fetch;
  beforeAll(async () => {
    await ensureAuthenticator();
    db = await freshDb('adapter_old', { files: [SHIM, join(MIGRATIONS_DIR, '0001_baseline.sql')] });
    const port = freePort();
    proc = await startPostgrest(db.name, port);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      origFetch(String(input).replace('/rest/v1/', '/'), init)) as typeof fetch;
    repo = createSupabaseRepository({ url: `http://127.0.0.1:${port}`, key: ANON, auth: fakeAuth(null) });
  }, 60_000);
  afterAll(async () => {
    globalThis.fetch = origFetch;
    proc?.kill();
    await db?.close();
  });
  it('读取自动退回 V72 的列（42703 → legacy select）', async () => {
    expect((await repo.forum.listThreads()).length).toBeGreaterThan(3);
    expect((await repo.forum.getThread(T.alice))?.title).toBe('alice thread');
    expect((await repo.forum.listReplies(T.bob)).length).toBe(5);
    expect((await repo.comments.list('article:pinyin-initial-search')).length).toBe(5);
  });
});
