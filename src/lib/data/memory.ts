import { memoryStore, type SessionStore } from './session';
import {
  AuthError,
  categoryId,
  checkLength,
  ForbiddenError,
  LIMITS,
  NotSignedInError,
  SEED_THREAD_RE,
  UUID_RE,
  ValidationError,
  type Comment,
  type DataRepository,
  type Notification,
  type Page,
  type SearchHit,
  type Profile,
  type Reply,
  type Report,
  type Role,
  type Session,
  type Thread,
} from './types';

export interface MemoryUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  role?: Role;
  banned?: boolean;
  confirmed?: boolean;
  provider?: string;
}

export interface MemorySeed {
  threads?: Thread[];
  replies?: Reply[];
  comments?: Comment[];
  users?: MemoryUser[];
  /** 静态种子主题 id → 是否锁定 */
  seedThreads?: Record<string, boolean>;
  /** 注册后是否需要邮箱验证（默认 true，与生产 Supabase 一致） */
  requireConfirmation?: boolean;
  store?: SessionStore;
  /** 生成 id / 时间（测试可注入） */
  now?: () => string;
}

const byDateDesc = (a: { createdAt: string }, b: { createdAt: string }) =>
  b.createdAt.localeCompare(a.createdAt);
const byDateAsc = (a: { createdAt: string }, b: { createdAt: string }) =>
  a.createdAt.localeCompare(b.createdAt);
/** (createdAt, id) 复合排序键，与数据库 keyset 分页一致 */
const key = (x: { createdAt: string; id: string }) => `${x.createdAt}|${x.id}`;
function pageOf<T extends { createdAt: string; id: string }>(
  sorted: T[],
  cursor: string | null | undefined,
  limit: number,
  dir: 'asc' | 'desc',
): Page<T> {
  const after = cursor ? sorted.filter((x) => (dir === 'desc' ? key(x) < cursor : key(x) > cursor)) : sorted;
  const items = after.slice(0, limit);
  return { items, next: after.length > limit ? key(items.at(-1)!) : null };
}
const clamp = (n: number | undefined, d: number) => Math.min(Math.max(Math.trunc(n ?? d), 1), 100);

let counter = 0;
const newId = () => {
  counter += 1;
  const hex = (Date.now().toString(16) + counter.toString(16).padStart(8, '0')).padStart(20, '0').slice(-20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${'0'.repeat(12)}`;
};

/**
 * 内存适配器：单元测试、离线开发，以及换库前的「契约基准」。
 * 权限规则按数据库（db/migrations 0004–0006）的语义简化实现：
 * 作者可改删自己的内容；版主可管理全部论坛内容；被封禁用户只读；管理员才能改角色。
 */
export function createMemoryRepository(seed: MemorySeed = {}): DataRepository {
  const now = seed.now ?? (() => new Date().toISOString());
  const threads: Thread[] = [...(seed.threads ?? [])].map((t) => ({
    published: true,
    locked: false,
    featured: false,
    ...t,
  }));
  const replies: Reply[] = [...(seed.replies ?? [])].map((r) => ({ published: true, ...r }));
  const comments: Comment[] = [...(seed.comments ?? [])].map((c) => ({ published: true, ...c }));
  const users = new Map(
    (seed.users ?? []).map((u) => [
      u.email.toLowerCase(),
      { confirmed: true, role: 'user' as Role, banned: false, provider: 'email', ...u },
    ]),
  );
  const profiles = new Map<string, Profile>();
  for (const u of users.values())
    profiles.set(u.id, {
      id: u.id,
      displayName: u.displayName,
      role: u.role,
      banned: u.banned,
      createdAt: now(),
    });
  const seedThreads = new Map(Object.entries(seed.seedThreads ?? {}));
  const likes = new Set<string>();
  const bookmarks: { userId: string; threadKey: string; createdAt: string }[] = [];
  const reports: Report[] = [];
  const notifications: (Notification & { userId: string })[] = [];
  const store = seed.store ?? memoryStore();
  const listeners = new Set<(s: Session | null) => void>();
  const requireConfirmation = seed.requireConfirmation ?? true;
  let notifSeq = 0;

  const sessionFor = (u: MemoryUser & { confirmed: boolean; provider: string }): Session => ({
    accessToken: `mem:${u.id}`,
    refreshToken: `mem-refresh:${u.id}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: u.id,
      email: u.email,
      emailConfirmed: u.confirmed,
      provider: u.provider,
      metaName: u.displayName,
    },
  });
  const setSession = (s: Session | null) => {
    store.set(s);
    listeners.forEach((l) => l(s));
  };
  const me = () => {
    const s = store.get();
    return s ? (profiles.get(s.user.id) ?? null) : null;
  };
  const requireUser = () => {
    const p = me();
    if (!p) throw new NotSignedInError();
    return p;
  };
  const requireWriter = () => {
    const p = requireUser();
    if (p.banned) throw new ForbiddenError('账号已被限制发言');
    return p;
  };
  const isMod = (p: Profile | null) => !!p && !p.banned && (p.role === 'moderator' || p.role === 'admin');
  const valid = (v: string, lim: readonly [number, number], label: string) => {
    const e = checkLength(v, lim, label);
    if (e) throw new ValidationError(e);
  };
  const authorOf = (p: Profile) => ({ id: p.id, name: p.displayName });
  const visible = <T extends { published?: boolean; author: { id: string | null } }>(x: T) => {
    const p = me();
    return x.published !== false || (p && x.author.id === p.id) || isMod(p);
  };
  const ownOrMod = (authorId: string | null) => {
    const p = requireUser();
    if (isMod(p)) return p;
    if (authorId !== p.id) throw new ForbiddenError('没有权限，或内容已被删除');
    return p;
  };
  const findUserById = (id: string) => [...users.values()].find((u) => u.id === id);

  return {
    name: 'memory',
    auth: {
      getSession: () => store.get(),
      accessToken: async () => store.get()?.accessToken ?? null,
      onChange(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async signUp(input) {
        const email = input.email.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
          throw new AuthError('邮箱地址不正确。', 'email_address_invalid');
        if (input.password.length < LIMITS.password[0])
          throw new AuthError('密码太弱：至少 8 位，并同时包含字母和数字。', 'weak_password');
        if (users.has(email))
          throw new AuthError('这个邮箱已经注册过了，可以直接登录或找回密码。', 'user_already_exists');
        const id = newId();
        const name = (input.displayName.trim() || email.split('@')[0]).slice(0, 40);
        const u = {
          id,
          email,
          password: input.password,
          displayName: name,
          role: 'user' as Role,
          banned: false,
          confirmed: !requireConfirmation,
          provider: 'email',
        };
        users.set(email, u);
        profiles.set(id, { id, displayName: name, role: 'user', banned: false, createdAt: now() });
        if (!requireConfirmation) {
          const s = sessionFor(u);
          setSession(s);
          return { session: s, needsConfirmation: false };
        }
        return { session: null, needsConfirmation: true };
      },
      async signIn(email, password) {
        const u = users.get(email.trim().toLowerCase());
        if (!u || u.password !== password) throw new AuthError('邮箱或密码不正确。', 'invalid_credentials');
        if (!u.confirmed)
          throw new AuthError(
            '邮箱还没有验证：请先点击确认邮件里的链接，或在下方重新发送。',
            'email_not_confirmed',
          );
        const s = sessionFor(u);
        setSession(s);
        return s;
      },
      async signOut() {
        setSession(null);
      },
      async requestPasswordReset() {
        /* 不暴露邮箱是否存在 */
      },
      async resendConfirmation() {},
      async updatePassword(password) {
        const p = requireUser();
        const u = findUserById(p.id)!;
        if (password.length < LIMITS.password[0])
          throw new AuthError('密码太弱：至少 8 位，并同时包含字母和数字。', 'weak_password');
        if (password === u.password) throw new AuthError('新密码不能与当前密码相同。', 'same_password');
        u.password = password;
      },
      async oauthUrl(provider, redirectTo) {
        const u = new URL(redirectTo, 'http://localhost');
        u.searchParams.set('code', `mem-${provider}`);
        return u.pathname + u.search;
      },
      async handleCallback(url) {
        const code = url.searchParams.get('code');
        if (code?.startsWith('mem-')) {
          const provider = code.slice(4);
          const email = `${provider}-user@example.com`;
          let u = users.get(email);
          if (!u) {
            const id = newId();
            u = {
              id,
              email,
              password: '',
              displayName: `${provider} 用户`,
              role: 'user',
              banned: false,
              confirmed: true,
              provider,
            };
            users.set(email, u);
            profiles.set(id, {
              id,
              displayName: u.displayName,
              role: 'user',
              banned: false,
              createdAt: now(),
            });
          }
          const s = sessionFor(u);
          setSession(s);
          return { session: s, type: 'oauth' };
        }
        const m = /access_token=mem:([^&]+)/.exec(url.hash);
        const type =
          (new URLSearchParams(url.hash.slice(1)).get('type') as 'signup' | 'recovery' | null) ?? null;
        if (m) {
          const u = findUserById(m[1]);
          if (u) {
            u.confirmed = true;
            const s = sessionFor(u);
            setSession(s);
            return { session: s, type };
          }
        }
        return { session: null, type, error: '链接不完整或已失效。' };
      },
    },
    profiles: {
      async get(id) {
        return profiles.get(id) ?? null;
      },
      async me() {
        return me();
      },
      async updateDisplayName(name) {
        const p = requireWriter();
        valid(name, LIMITS.displayName, '昵称');
        const next = { ...p, displayName: name.trim() };
        profiles.set(p.id, next);
        return next;
      },
    },
    forum: {
      async listThreads(opts = {}) {
        let list = threads
          .filter((t) => t.published !== false)
          .filter((t) => !opts.category || t.category === opts.category)
          .sort(byDateDesc)
          .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
        if (opts.limit) list = list.slice(0, opts.limit);
        return list;
      },
      async getThread(id) {
        const t = threads.find((x) => x.id === id);
        return t && visible(t) ? t : null;
      },
      async getThreadsByIds(ids) {
        return threads.filter((t) => ids.includes(t.id) && visible(t));
      },
      async listReplies(threadId) {
        return replies.filter((r) => r.threadId === threadId && r.published !== false).sort(byDateAsc);
      },
      async replyCounts() {
        const m: Record<string, number> = {};
        for (const r of replies) if (r.published !== false) m[r.threadId] = (m[r.threadId] ?? 0) + 1;
        return m;
      },
      async createThread(input) {
        const p = requireWriter();
        valid(input.title, LIMITS.threadTitle, '标题');
        valid(input.body, LIMITS.threadBody, '正文');
        const category = categoryId(input.category);
        if (category === 'announce' && p.role !== 'admin')
          throw new ForbiddenError('只有管理员可以在「公告」发帖');
        const t: Thread = {
          id: newId(),
          category,
          title: input.title.trim(),
          body: input.body.trim(),
          author: authorOf(p),
          pinned: false,
          locked: false,
          featured: false,
          published: true,
          createdAt: now(),
          editedAt: null,
        };
        threads.push(t);
        return t;
      },
      async updateThread(id, patch) {
        const t = threads.find((x) => x.id === id);
        if (!t) throw new ForbiddenError('没有权限，或内容已被删除');
        const p = ownOrMod(t.author.id);
        if (p.banned) throw new ForbiddenError('账号已被限制发言');
        if (t.locked && !isMod(p)) throw new ForbiddenError('主题已锁定，不能编辑');
        if (patch.title !== undefined) valid(patch.title, LIMITS.threadTitle, '标题');
        if (patch.body !== undefined) valid(patch.body, LIMITS.threadBody, '正文');
        if (patch.category === 'announce' && p.role !== 'admin')
          throw new ForbiddenError('只有管理员可以把主题移到「公告」');
        Object.assign(t, {
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
          ...(patch.category !== undefined ? { category: categoryId(patch.category) } : {}),
          editedAt: patch.title !== undefined || patch.body !== undefined ? now() : t.editedAt,
        });
        return t;
      },
      async deleteThread(id) {
        const i = threads.findIndex((x) => x.id === id);
        if (i < 0) throw new ForbiddenError('没有权限，或内容已被删除');
        ownOrMod(threads[i].author.id);
        threads.splice(i, 1);
        for (let j = replies.length - 1; j >= 0; j--) if (replies[j].threadId === id) replies.splice(j, 1);
      },
      async setThreadFlags(id, flags) {
        const p = requireUser();
        if (!isMod(p)) throw new ForbiddenError('pinned / locked / featured / published 仅版主可修改');
        const t = threads.find((x) => x.id === id);
        if (!t) throw new ForbiddenError('没有权限，或内容已被删除');
        Object.assign(t, flags);
        return t;
      },
      async reply(threadId, body) {
        const p = requireWriter();
        valid(body, LIMITS.replyBody, '回复');
        if (SEED_THREAD_RE.test(threadId)) {
          if (!seedThreads.has(threadId)) throw new ValidationError('主题不存在');
          if (seedThreads.get(threadId) && !isMod(p)) throw new ForbiddenError('主题已锁定或不可回复');
        } else {
          const t = threads.find((x) => x.id === threadId);
          if (!t) throw new ValidationError('主题不存在');
          if ((t.locked || t.published === false) && !isMod(p))
            throw new ForbiddenError('主题已锁定或不可回复');
          if (t.author.id && t.author.id !== p.id) {
            notifSeq += 1;
            notifications.push({
              id: notifSeq,
              userId: t.author.id,
              kind: 'reply',
              actorName: p.displayName,
              threadKey: t.id,
              targetType: 'reply',
              targetId: null,
              excerpt: body.trim().slice(0, 140),
              read: false,
              createdAt: now(),
            });
          }
        }
        const r: Reply = {
          id: newId(),
          threadId,
          body: body.trim(),
          author: authorOf(p),
          createdAt: now(),
          editedAt: null,
          published: true,
        };
        replies.push(r);
        return r;
      },
      async updateReply(id, body) {
        const r = replies.find((x) => x.id === id);
        if (!r) throw new ForbiddenError('没有权限，或内容已被删除');
        const p = ownOrMod(r.author.id);
        if (p.banned) throw new ForbiddenError('账号已被限制发言');
        valid(body, LIMITS.replyBody, '回复');
        Object.assign(r, { body: body.trim(), editedAt: now() });
        return r;
      },
      async deleteReply(id) {
        const i = replies.findIndex((x) => x.id === id);
        if (i < 0) throw new ForbiddenError('没有权限，或内容已被删除');
        ownOrMod(replies[i].author.id);
        replies.splice(i, 1);
      },
      async pageThreads(q = {}) {
        const list = threads
          .filter((t) => t.published !== false)
          .filter((t) => !q.category || t.category === q.category)
          .filter((t) => !q.author || t.author.id === q.author)
          .filter((t) => !q.excludePinned || !t.pinned)
          .sort((a, b) => key(b).localeCompare(key(a)));
        return pageOf(list, q.cursor, clamp(q.limit, 20), 'desc');
      },
      async pinnedThreads(opts = {}) {
        return threads
          .filter((t) => t.published !== false && t.pinned)
          .filter((t) => !opts.category || t.category === opts.category)
          .sort(byDateDesc);
      },
      async pageReplies(threadId, opts = {}) {
        const list = replies
          .filter((r) => r.threadId === threadId)
          .filter((r) => (opts.withHidden ? visible(r) : r.published !== false))
          .sort((a, b) => key(a).localeCompare(key(b)));
        return pageOf(list, opts.cursor, clamp(opts.limit, 30), 'asc');
      },
      async replyCountsFor(ids) {
        const out: Record<string, number> = Object.fromEntries(ids.map((k) => [k, 0]));
        for (const r of replies) if (r.published !== false && r.threadId in out) out[r.threadId] += 1;
        return out;
      },
      async search(term, opts = {}) {
        const t = term.trim().toLowerCase();
        if (!t) return [];
        const hits = threads
          .filter((x) => x.published !== false)
          .filter((x) => x.title.toLowerCase().includes(t) || x.body.toLowerCase().includes(t))
          .sort(
            (a, b) =>
              Number(b.title.toLowerCase().includes(t)) - Number(a.title.toLowerCase().includes(t)) ||
              byDateDesc(a, b),
          );
        const off = opts.offset ?? 0;
        return hits.slice(off, off + clamp(opts.limit, 20)).map((x): SearchHit => ({
          id: x.id,
          category: x.category,
          title: x.title,
          excerpt: x.body.replace(/\s+/g, ' ').slice(0, 160),
          author: x.author,
          createdAt: x.createdAt,
        }));
      },
      async seedThread(k) {
        return seedThreads.has(k) ? { key: k, locked: !!seedThreads.get(k) } : null;
      },
      async setSeedLocked(k, locked) {
        const p = requireUser();
        if (!isMod(p)) throw new ForbiddenError('没有权限，或内容已被删除');
        if (!seedThreads.has(k)) throw new ForbiddenError('没有权限，或内容已被删除');
        seedThreads.set(k, locked);
        return { key: k, locked };
      },
      async setReplyPublished(id, published) {
        const p = requireUser();
        const r = replies.find((x) => x.id === id);
        if (!r || !isMod(p)) throw new ForbiddenError('没有权限，或内容已被删除');
        r.published = published;
        return r;
      },
      async like(type, id) {
        const p = requireWriter();
        likes.add(`${p.id}|${type}|${id}`);
      },
      async unlike(type, id) {
        const p = requireUser();
        likes.delete(`${p.id}|${type}|${id}`);
      },
      async likeSummary(type, ids) {
        const p = me();
        const out: Record<string, { likes: number; liked: boolean }> = {};
        for (const id of ids) {
          const keys = [...likes].filter((k) => k.endsWith(`|${type}|${id}`));
          out[id] = { likes: keys.length, liked: !!p && keys.includes(`${p.id}|${type}|${id}`) };
        }
        return out;
      },
    },
    comments: {
      async list(pageKey, opts = {}) {
        return comments
          .filter((c) => c.pageKey === pageKey && (opts.withHidden ? visible(c) : c.published !== false))
          .sort(byDateAsc);
      },
      async setPublished(id, published) {
        const p = requireUser();
        const c = comments.find((x) => x.id === id);
        if (!c || !isMod(p)) throw new ForbiddenError('没有权限，或内容已被删除');
        c.published = published;
        return c;
      },
      async create(pageKey, body) {
        const p = requireWriter();
        valid(body, LIMITS.commentBody, '评论');
        if (!/^(article|game|work|project):[a-z0-9-]{1,60}$/.test(pageKey))
          throw new ValidationError('页面标识不正确');
        const c: Comment = {
          id: newId(),
          pageKey,
          body: body.trim(),
          author: authorOf(p),
          createdAt: now(),
          editedAt: null,
          published: true,
        };
        comments.push(c);
        return c;
      },
      async update(id, body) {
        const c = comments.find((x) => x.id === id);
        if (!c) throw new ForbiddenError('没有权限，或内容已被删除');
        const p = ownOrMod(c.author.id);
        if (p.banned) throw new ForbiddenError('账号已被限制发言');
        valid(body, LIMITS.commentBody, '评论');
        Object.assign(c, { body: body.trim(), editedAt: now() });
        return c;
      },
      async remove(id) {
        const i = comments.findIndex((x) => x.id === id);
        if (i < 0) throw new ForbiddenError('没有权限，或内容已被删除');
        ownOrMod(comments[i].author.id);
        comments.splice(i, 1);
      },
    },
    reports: {
      async create(input) {
        const p = requireWriter();
        valid(input.detail ?? '', LIMITS.reportDetail, '补充说明');
        if (
          reports.some(
            (r) =>
              r.reporter === p.id &&
              r.targetId === input.targetId &&
              r.targetType === input.targetType &&
              r.status === 'open',
          )
        )
          throw new ValidationError('已经提交过了');
        const r: Report = {
          id: newId(),
          reporter: p.id,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          detail: (input.detail ?? '').trim(),
          status: 'open',
          resolutionNote: '',
          createdAt: now(),
          resolvedAt: null,
        };
        reports.push(r);
        return r;
      },
      async listMine() {
        const p = requireUser();
        return reports.filter((r) => r.reporter === p.id).sort(byDateDesc);
      },
      async listOpen() {
        const p = requireUser();
        // 与 RLS 一致：版主看到全部，普通用户只看到自己提交的
        return reports
          .filter((r) => r.status === 'open' && (isMod(p) || r.reporter === p.id))
          .sort(byDateAsc);
      },
      async resolve(id, status, note = '') {
        const p = requireUser();
        if (!isMod(p)) throw new ForbiddenError('没有权限，或内容已被删除');
        const r = reports.find((x) => x.id === id);
        if (!r) throw new ForbiddenError('没有权限，或内容已被删除');
        Object.assign(r, { status, resolutionNote: note.trim(), resolvedAt: now() });
        if (r.reporter) {
          notifSeq += 1;
          notifications.push({
            id: notifSeq,
            userId: r.reporter,
            kind: 'report',
            actorName: p.displayName,
            threadKey: null,
            targetType: r.targetType,
            targetId: r.targetId,
            excerpt: status === 'resolved' ? '你的举报已处理，感谢反馈。' : '你的举报已查看，暂未发现违规。',
            read: false,
            createdAt: now(),
          });
        }
        return r;
      },
    },
    notifications: {
      async list(opts = {}) {
        const p = requireUser();
        return notifications
          .filter((n) => n.userId === p.id)
          .sort((a, b) => b.id - a.id)
          .slice(0, opts.limit ?? 50)
          .map(({ userId: _u, ...n }) => n); // eslint-disable-line @typescript-eslint/no-unused-vars
      },
      async unreadCount() {
        const p = me();
        return p ? notifications.filter((n) => n.userId === p.id && !n.read).length : 0;
      },
      async markRead(ids) {
        const p = requireUser();
        let n = 0;
        for (const x of notifications)
          if (x.userId === p.id && !x.read && (!ids || ids.includes(x.id))) {
            x.read = true;
            n += 1;
          }
        return n;
      },
    },
    bookmarks: {
      async list() {
        const p = requireUser();
        return bookmarks
          .filter((b) => b.userId === p.id)
          .sort(byDateDesc)
          .map((b) => ({ threadKey: b.threadKey, createdAt: b.createdAt }));
      },
      async add(threadKey) {
        const p = requireUser();
        if (!SEED_THREAD_RE.test(threadKey) && !UUID_RE.test(threadKey))
          throw new ValidationError('内容长度或格式不符合要求');
        if (!bookmarks.some((b) => b.userId === p.id && b.threadKey === threadKey))
          bookmarks.push({ userId: p.id, threadKey, createdAt: now() });
      },
      async remove(threadKey) {
        const p = requireUser();
        const i = bookmarks.findIndex((b) => b.userId === p.id && b.threadKey === threadKey);
        if (i >= 0) bookmarks.splice(i, 1);
      },
      async has(keys) {
        const p = me();
        if (!p) return new Set();
        return new Set(
          bookmarks.filter((b) => b.userId === p.id && keys.includes(b.threadKey)).map((b) => b.threadKey),
        );
      },
    },
  };
}
