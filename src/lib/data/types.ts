/**
 * 仓储接口：前端只依赖这些接口，不直接依赖 Supabase。
 * 换数据库 = 新写一个实现这些接口的适配器（见 supabase.ts / memory.ts）。
 * 权限一律由数据库（RLS + 触发器，db/migrations）强制；这里的判断只用于体验（隐藏按钮等）。
 */
export interface Author {
  id: string | null;
  name: string;
  /** 站长/官方内容 */
  site?: boolean;
}

export interface Thread {
  id: string;
  category: string; // 分类 id：announce | product | tech | meta
  title: string;
  body: string; // 纯文本（渲染时转义）
  author: Author;
  pinned: boolean;
  locked?: boolean;
  featured?: boolean;
  published?: boolean;
  createdAt: string; // ISO
  editedAt?: string | null;
}

export interface Reply {
  id: string;
  threadId: string;
  body: string;
  author: Author;
  createdAt: string;
  editedAt?: string | null;
  published?: boolean;
}

export interface Comment {
  id: string;
  pageKey: string; // 例：article:pinyin-initial-search
  body: string;
  author: Author;
  createdAt: string;
  editedAt?: string | null;
  published?: boolean;
}

// ------------------------------------------------------------------ 账户 ----

export type Role = 'user' | 'moderator' | 'admin';
export type OAuthProvider = 'github' | 'google';

export interface AuthUser {
  id: string;
  email: string | null;
  emailConfirmed: boolean;
  /** email | github | google … */
  provider: string;
  /** 注册时填写的昵称（user_metadata.name） */
  metaName?: string | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** unix 秒 */
  expiresAt: number;
  user: AuthUser;
}

export interface Profile {
  id: string;
  displayName: string;
  role: Role;
  banned: boolean;
  createdAt: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
  /** Turnstile 校验通过后服务端签发的票据（见 /api/auth/*），或直接传给 GoTrue 的 captcha token */
  captchaToken?: string;
  /** 邮件里确认链接要回到的地址（/auth/callback/） */
  redirectTo?: string;
}

export type CallbackType = 'signup' | 'recovery' | 'oauth' | 'magiclink' | 'email_change' | 'invite' | null;

export interface CallbackResult {
  session: Session | null;
  type: CallbackType;
  error?: string;
}

export interface AuthProvider {
  /** 本地会话（不发请求）；没有登录返回 null */
  getSession(): Session | null;
  /** 有效的 access token（快过期时自动刷新）；未登录返回 null */
  accessToken(): Promise<string | null>;
  onChange(cb: (s: Session | null) => void): () => void;
  signUp(input: SignUpInput): Promise<{ session: Session | null; needsConfirmation: boolean }>;
  signIn(email: string, password: string): Promise<Session>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string, opts?: { redirectTo?: string; captchaToken?: string }): Promise<void>;
  updatePassword(password: string): Promise<void>;
  resendConfirmation(email: string, opts?: { redirectTo?: string; captchaToken?: string }): Promise<void>;
  /** 第三方登录跳转地址（PKCE） */
  oauthUrl(provider: OAuthProvider, redirectTo: string): Promise<string>;
  /** /auth/callback/ 页面调用：解析邮件链接 / OAuth 回跳，建立会话 */
  handleCallback(url: URL): Promise<CallbackResult>;
}

export interface ProfileRepo {
  get(id: string): Promise<Profile | null>;
  /** 当前登录用户的资料；未登录返回 null */
  me(): Promise<Profile | null>;
  updateDisplayName(name: string): Promise<Profile>;
}

// ------------------------------------------------------------------ 论坛 ----

export interface NewThread {
  category: string; // 分类 id
  title: string;
  body: string;
}

export interface ThreadFlags {
  pinned?: boolean;
  locked?: boolean;
  featured?: boolean;
  published?: boolean;
}

export interface LikeSummary {
  likes: number;
  liked: boolean;
}

/** 游标分页：next 为 null 表示没有更多 */
export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ThreadQuery {
  category?: string;
  /** 只看某个用户的主题（个人主页） */
  author?: string;
  limit?: number;
  /** 上一页返回的 next */
  cursor?: string | null;
  /** true = 不含置顶（列表页另取置顶） */
  excludePinned?: boolean;
}

export interface SearchHit {
  id: string;
  category: string;
  title: string;
  excerpt: string;
  author: Author;
  createdAt: string;
}

export interface SeedThreadState {
  key: string;
  locked: boolean;
}

export interface ForumRepo {
  listThreads(opts?: { category?: string; limit?: number }): Promise<Thread[]>;
  /** 按时间倒序（created_at desc, id desc）的游标分页，只含已发布主题 */
  pageThreads(q?: ThreadQuery): Promise<Page<Thread>>;
  /** 置顶主题（已发布），列表页放在最前 */
  pinnedThreads(opts?: { category?: string }): Promise<Thread[]>;
  /** 回复：按时间正序分页。withHidden = 让数据库按 RLS 返回自己的/版主可见的隐藏回复 */
  pageReplies(
    threadId: string,
    opts?: { limit?: number; cursor?: string | null; withHidden?: boolean },
  ): Promise<Page<Reply>>;
  /** 多条主题（uuid 或种子 t-…）的已发布回复数 */
  replyCountsFor(threadIds: string[]): Promise<Record<string, number>>;
  /** 论坛全文搜索（pg_trgm / ILIKE），只含已发布主题 */
  search(q: string, opts?: { limit?: number; offset?: number }): Promise<SearchHit[]>;
  /** 静态种子主题的状态（是否锁定）；表不存在（旧库）返回 null */
  seedThread(key: string): Promise<SeedThreadState | null>;
  /** 版主：锁定 / 解锁种子主题 */
  setSeedLocked(key: string, locked: boolean): Promise<SeedThreadState>;
  /** 版主：隐藏 / 恢复回复 */
  setReplyPublished(id: string, published: boolean): Promise<Reply>;
  getThread(id: string): Promise<Thread | null>;
  /** 批量取主题（收藏夹、通知）；不存在 / 不可见的直接缺省 */
  getThreadsByIds(ids: string[]): Promise<Thread[]>;
  listReplies(threadId: string): Promise<Reply[]>;
  replyCounts(): Promise<Record<string, number>>;
  createThread(input: NewThread): Promise<Thread>;
  updateThread(id: string, patch: { title?: string; body?: string; category?: string }): Promise<Thread>;
  deleteThread(id: string): Promise<void>;
  /** 版主：置顶 / 锁定 / 精华 / 隐藏 */
  setThreadFlags(id: string, flags: ThreadFlags): Promise<Thread>;
  /** threadId 可以是数据库主题 uuid，也可以是静态种子主题 id（t-…） */
  reply(threadId: string, body: string): Promise<Reply>;
  updateReply(id: string, body: string): Promise<Reply>;
  deleteReply(id: string): Promise<void>;
  like(targetType: 'thread' | 'reply' | 'comment', id: string): Promise<void>;
  unlike(targetType: 'thread' | 'reply' | 'comment', id: string): Promise<void>;
  likeSummary(
    targetType: 'thread' | 'reply' | 'comment',
    ids: string[],
  ): Promise<Record<string, LikeSummary>>;
}

export interface CommentRepo {
  /** withHidden = 让数据库按 RLS 返回自己的/版主可见的隐藏评论 */
  list(pageKey: string, opts?: { withHidden?: boolean }): Promise<Comment[]>;
  /** 版主：隐藏 / 恢复评论 */
  setPublished(id: string, published: boolean): Promise<Comment>;
  create(pageKey: string, body: string): Promise<Comment>;
  update(id: string, body: string): Promise<Comment>;
  remove(id: string): Promise<void>;
}

// ------------------------------------------------------------ 举报 / 通知 ----

export type ReportReason = 'spam' | 'abuse' | 'illegal' | 'privacy' | 'other';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';
export type ReportTarget = 'thread' | 'reply' | 'comment' | 'profile' | 'review';

export interface Report {
  id: string;
  reporter: string | null;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  detail: string;
  status: ReportStatus;
  resolutionNote: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReportRepo {
  create(input: {
    targetType: ReportTarget;
    targetId: string;
    reason: ReportReason;
    detail?: string;
  }): Promise<Report>;
  listMine(): Promise<Report[]>;
  /** 待处理举报：版主看到全部（审核队列），普通用户只看到自己提交的 */
  listOpen(): Promise<Report[]>;
  resolve(id: string, status: Exclude<ReportStatus, 'open'>, note?: string): Promise<Report>;
}

export type NotificationKind = 'reply' | 'mention' | 'like' | 'report' | 'moderation' | 'system';

export interface Notification {
  id: number;
  kind: NotificationKind;
  actorName: string | null;
  threadKey: string | null;
  targetType: string | null;
  targetId: string | null;
  excerpt: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationRepo {
  list(opts?: { limit?: number }): Promise<Notification[]>;
  unreadCount(): Promise<number>;
  /** 不传 ids = 全部标记已读；返回标记的条数 */
  markRead(ids?: number[]): Promise<number>;
}

export interface Bookmark {
  /** 数据库主题 uuid 或种子主题 t-… */
  threadKey: string;
  createdAt: string;
}

export interface BookmarkRepo {
  /** 我的收藏，按时间倒序 */
  list(): Promise<Bookmark[]>;
  add(threadKey: string): Promise<void>;
  remove(threadKey: string): Promise<void>;
  /** 给定主题里哪些被我收藏了 */
  has(threadKeys: string[]): Promise<Set<string>>;
}

/** 用户图片存储（编辑器上传） */
export interface MediaRepo {
  /** 上传一张已压缩好的图片；返回公开 URL 与对象路径。超限 / 无权限 / 限流时抛中文错误。 */
  uploadImage(
    blob: Blob,
    meta: { width: number; height: number; ext: import('../images').ImageExt },
  ): Promise<{ url: string; path: string }>;
  /** 删除对象（本人自己的图；版主任何图）——路径为 `<uid>/<文件名>` */
  deleteImage(path: string): Promise<void>;
}

export interface DataRepository {
  readonly name: string;
  auth: AuthProvider;
  profiles: ProfileRepo;
  forum: ForumRepo;
  comments: CommentRepo;
  reports: ReportRepo;
  notifications: NotificationRepo;
  bookmarks: BookmarkRepo;
  /** 用户图片（P5，Supabase Storage `ugc-images` 桶）；没有对象存储的适配器不提供 */
  media?: MediaRepo;
  /** 管理后台（P4）；内存适配器不提供 */
  admin?: import('./admin').AdminRepo;
}

// ------------------------------------------------------------------ 错误 ----

/**
 * 读取失败的原因分类（A15）：网络断开、请求超时、服务端 5xx、响应格式异常、数据库缺少对象（未迁移）。
 * 后台按 kind 给出不同提示，不再把「库没迁移」说成「网络不可用」。
 */
export type UnavailableKind = 'network' | 'timeout' | 'server' | 'bad-response' | 'schema';

/** 后端不可达时抛出，UI 进入只读/离线提示 */
export class DataUnavailableError extends Error {
  readonly kind: UnavailableKind;
  readonly status: number | null;
  constructor(message = '数据服务暂时不可达', opts: { kind?: UnavailableKind; status?: number | null } = {}) {
    super(message);
    this.name = 'DataUnavailableError';
    this.kind = opts.kind ?? 'network';
    this.status = opts.status ?? null;
  }
}

/**
 * 数据库缺少接口需要的 RPC / 表 / 列（PostgREST PGRST202 / PGRST205 / 42703，HTTP 404 / 400）：
 * 说明迁移没有执行，重试不会恢复。object = 缺少的对象名，migration = 创建它的迁移编号（未知时 null）。
 * 继承 DataUnavailableError：只认父类的旧代码照样把它当「暂不可用」处理。
 */
export class SchemaMissingError extends DataUnavailableError {
  readonly object: string;
  readonly code: string;
  readonly migration: string | null;
  constructor(object: string, code: string, migration: string | null) {
    super(
      migration
        ? `数据库缺少「${object}」（迁移 ${migration} 未执行）`
        : `数据库缺少「${object}」（相关迁移未执行）`,
      { kind: 'schema', status: 404 },
    );
    this.name = 'SchemaMissingError';
    this.object = object;
    this.code = code;
    this.migration = migration;
  }
}

/** 需要登录 */
export class NotSignedInError extends Error {
  constructor(message = '请先登录') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

/** 数据库拒绝（RLS / 列权限 / 触发器）：HTTP 401/403，SQLSTATE 42501 */
export class ForbiddenError extends Error {
  constructor(message = '没有权限执行这个操作') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 限流：HTTP 429，SQLSTATE PT429 */
export class RateLimitedError extends Error {
  /** 数据库 az_rate_limit() 的 detail，例如「thread: 最多 3 次 / 00:10:00」 */
  detail: string;
  constructor(message = '操作太频繁，请稍后再试', detail = '') {
    super(message);
    this.name = 'RateLimitedError';
    this.detail = detail;
  }
}

/** 登录 / 注册 / 重置密码失败；message 已是给用户看的中文 */
export class AuthError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'unknown', status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** 其他输入错误（长度、格式、目标不存在） */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 旧站分类以中文名存库（cat='产品讨论'），这里统一成 id */
export const CATEGORY_IDS: Record<string, string> = {
  公告: 'announce',
  产品讨论: 'product',
  技术交流: 'tech',
  站务反馈: 'meta',
};
export const CATEGORY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_IDS).map(([name, id]) => [id, name]),
);
export const categoryId = (cat: string) =>
  CATEGORY_IDS[cat] ?? (Object.values(CATEGORY_IDS).includes(cat) ? cat : 'meta');
/** 写库时用中文名（与 V72 一致，cat 列是中文） */
export const categoryName = (id: string) => CATEGORY_NAMES[id] ?? (CATEGORY_IDS[id] ? id : '站务反馈');

export const LIMITS = {
  displayName: [1, 40],
  threadTitle: [1, 120],
  threadBody: [1, 4000],
  replyBody: [1, 2000],
  commentBody: [1, 600],
  reportDetail: [0, 500],
  password: [8, 72],
} as const;

/** 与数据库约束一致的前端校验；返回中文错误或 null */
export function checkLength(
  value: string,
  [min, max]: readonly [number, number],
  label: string,
): string | null {
  const n = [...value.trim()].length;
  if (n < min) return min <= 1 ? `${label}不能为空` : `${label}至少 ${min} 个字符`;
  if (n > max) return `${label}最多 ${max} 个字符`;
  return null;
}

export const SEED_THREAD_RE = /^t-[a-z0-9-]{1,58}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
