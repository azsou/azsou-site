import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createMemoryRepository,
  ForbiddenError,
  NotSignedInError,
  ValidationError,
  type DataRepository,
} from '@/lib/data';

const users = [
  { id: 'u-alice', email: 'alice@example.com', password: 'alicepass1', displayName: 'alice' },
  { id: 'u-bob', email: 'bob@example.com', password: 'bobpass12', displayName: 'bob' },
  { id: 'u-carol', email: 'carol@example.com', password: 'carolpass1', displayName: 'carol', banned: true },
  {
    id: 'u-mia',
    email: 'mia@example.com',
    password: 'miapass12',
    displayName: 'mia',
    role: 'moderator' as const,
  },
  {
    id: 'u-ada',
    email: 'ada@example.com',
    password: 'adapass12',
    displayName: 'ada',
    role: 'admin' as const,
  },
];
const fresh = () =>
  createMemoryRepository({ users, seedThreads: { 't-announce': false, 't-feedback': true } });
const login = async (repo: DataRepository, who: string) => {
  const u = users.find((x) => x.displayName === who)!;
  await repo.auth.signIn(u.email, u.password);
};

describe('memory adapter · 账户', () => {
  it('注册需要邮箱验证；验证前不能登录；回调后建立会话', async () => {
    const repo = fresh();
    const r = await repo.auth.signUp({
      email: 'New@Example.com',
      password: 'secret123',
      displayName: ' 新人 ',
    });
    expect(r).toEqual({ session: null, needsConfirmation: true });
    await expect(repo.auth.signIn('new@example.com', 'secret123')).rejects.toMatchObject({
      code: 'email_not_confirmed',
    });
    await expect(
      repo.auth.signUp({ email: 'new@example.com', password: 'secret123', displayName: 'x' }),
    ).rejects.toBeInstanceOf(AuthError);
  });
  it('登录 / 资料 / 改昵称 / 登出，onChange 收到通知', async () => {
    const repo = fresh();
    const seen: (string | null)[] = [];
    repo.auth.onChange((s) => seen.push(s?.user.id ?? null));
    await expect(repo.auth.signIn('alice@example.com', 'nope')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    await login(repo, 'alice');
    expect((await repo.profiles.me())?.displayName).toBe('alice');
    expect((await repo.profiles.updateDisplayName('  Alice Z ')).displayName).toBe('Alice Z');
    await expect(repo.profiles.updateDisplayName('x'.repeat(41))).rejects.toBeInstanceOf(ValidationError);
    await repo.auth.signOut();
    expect(repo.auth.getSession()).toBeNull();
    expect(await repo.profiles.me()).toBeNull();
    expect(seen).toEqual(['u-alice', null]);
  });
  it('OAuth：oauthUrl → handleCallback(?code=) 建立会话', async () => {
    const repo = fresh();
    const url = await repo.auth.oauthUrl('github', '/auth/callback/');
    const r = await repo.auth.handleCallback(new URL(url, 'http://x'));
    expect(r.type).toBe('oauth');
    expect(r.session?.user.provider).toBe('github');
  });
  it('改密码：太短 / 与旧密码相同 都拒绝', async () => {
    const repo = fresh();
    await login(repo, 'bob');
    await expect(repo.auth.updatePassword('short')).rejects.toMatchObject({ code: 'weak_password' });
    await expect(repo.auth.updatePassword('bobpass12')).rejects.toMatchObject({ code: 'same_password' });
    await repo.auth.updatePassword('newpass123');
    await repo.auth.signOut();
    await repo.auth.signIn('bob@example.com', 'newpass123');
  });
});

describe('memory adapter · 论坛权限（与数据库 RLS 语义一致）', () => {
  it('未登录不能写；被封禁只读', async () => {
    const repo = fresh();
    await expect(repo.forum.createThread({ category: 'tech', title: 't', body: 'b' })).rejects.toBeInstanceOf(
      NotSignedInError,
    );
    await login(repo, 'carol');
    await expect(repo.forum.createThread({ category: 'tech', title: 't', body: 'b' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repo.comments.create('article:x', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('作者能编辑 / 删除自己的主题，不能动别人的；只有管理员能发公告', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const t = await repo.forum.createThread({ category: 'tech', title: ' 标题 ', body: '正文' });
    expect(t).toMatchObject({ title: '标题', category: 'tech', pinned: false, author: { id: 'u-alice' } });
    await expect(
      repo.forum.createThread({ category: 'announce', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await repo.forum.updateThread(t.id, { body: '改过' })).editedAt).toBeTruthy();
    await expect(repo.forum.setThreadFlags(t.id, { pinned: true })).rejects.toBeInstanceOf(ForbiddenError);
    await repo.auth.signOut();
    await login(repo, 'bob');
    await expect(repo.forum.updateThread(t.id, { body: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repo.forum.deleteThread(t.id)).rejects.toBeInstanceOf(ForbiddenError);
    await repo.auth.signOut();
    await login(repo, 'ada');
    await repo.forum.createThread({ category: 'announce', title: '公告', body: 'b' });
  });
  it('版主：置顶 / 锁定；锁定后普通用户不能回复，版主可以', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const t = await repo.forum.createThread({ category: 'product', title: 't', body: 'b' });
    await repo.auth.signOut();
    await login(repo, 'mia');
    expect(await repo.forum.setThreadFlags(t.id, { pinned: true, locked: true })).toMatchObject({
      pinned: true,
      locked: true,
    });
    await repo.forum.reply(t.id, '版主回复');
    await repo.auth.signOut();
    await login(repo, 'bob');
    await expect(repo.forum.reply(t.id, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    expect((await repo.forum.listThreads())[0].id).toBe(t.id); // 置顶在前
  });
  it('种子主题：可以回复，锁定的不行，不存在的报错', async () => {
    const repo = fresh();
    await login(repo, 'bob');
    expect((await repo.forum.reply('t-announce', 'hi')).threadId).toBe('t-announce');
    await expect(repo.forum.reply('t-feedback', 'hi')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repo.forum.reply('t-nope', 'hi')).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.forum.replyCounts())['t-announce']).toBe(1);
  });
  it('回复别人的主题 → 对方收到通知；标记已读', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const t = await repo.forum.createThread({ category: 'tech', title: 't', body: 'b' });
    await repo.auth.signOut();
    await login(repo, 'bob');
    await repo.forum.reply(t.id, '你好 alice');
    await repo.auth.signOut();
    await login(repo, 'alice');
    expect(await repo.notifications.unreadCount()).toBe(1);
    const [n] = await repo.notifications.list();
    expect(n).toMatchObject({ kind: 'reply', actorName: 'bob', excerpt: '你好 alice', read: false });
    expect(await repo.notifications.markRead()).toBe(1);
    expect(await repo.notifications.unreadCount()).toBe(0);
  });
  it('点赞汇总', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    await repo.forum.like('thread', 'x');
    await repo.forum.like('thread', 'x');
    expect(await repo.forum.likeSummary('thread', ['x', 'y'])).toEqual({
      x: { likes: 1, liked: true },
      y: { likes: 0, liked: false },
    });
    await repo.forum.unlike('thread', 'x');
    expect((await repo.forum.likeSummary('thread', ['x'])).x.likes).toBe(0);
  });
  it('评论：长度校验 / 作者删除 / 版主删除别人的', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    await expect(repo.comments.create('article:x', 'x'.repeat(601))).rejects.toBeInstanceOf(ValidationError);
    const c = await repo.comments.create('article:x', '评论');
    expect((await repo.comments.update(c.id, '改')).editedAt).toBeTruthy();
    const c2 = await repo.comments.create('article:x', '第二条');
    await repo.comments.remove(c.id);
    await repo.auth.signOut();
    await login(repo, 'bob');
    await expect(repo.comments.remove(c2.id)).rejects.toBeInstanceOf(ForbiddenError);
    await repo.auth.signOut();
    await login(repo, 'mia');
    await repo.comments.remove(c2.id);
    expect(await repo.comments.list('article:x')).toEqual([]);
  });
  it('举报：重复举报拒绝；版主处理后举报人收到通知', async () => {
    const repo = fresh();
    await login(repo, 'alice');
    const r = await repo.reports.create({ targetType: 'thread', targetId: 't1', reason: 'spam' });
    await expect(
      repo.reports.create({ targetType: 'thread', targetId: 't1', reason: 'spam' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await repo.reports.listOpen()).map((x) => x.reporter)).toEqual(['u-alice']); // 普通用户只看到自己的
    await expect(repo.reports.resolve(r.id, 'resolved')).rejects.toBeInstanceOf(ForbiddenError);
    await repo.auth.signOut();
    await login(repo, 'mia');
    expect((await repo.reports.listOpen()).map((x) => x.id)).toEqual([r.id]);
    expect((await repo.reports.resolve(r.id, 'resolved', '已删除')).status).toBe('resolved');
    await repo.auth.signOut();
    await login(repo, 'alice');
    expect((await repo.notifications.list())[0].kind).toBe('report');
    expect((await repo.reports.listMine())[0].status).toBe('resolved');
  });
});
