/**
 * 后台 CRM 扩展（迁移 0017：备注 / 用户画像与标签 / 内容流程 / 版本）。
 * 单独成模块、只被后台页面（懒）加载：公开页面经数据层引入 admin.ts，不应为后台功能多背体积（首屏 JS 预算 50KB）。
 */
import { uuidList, type AdminRest, type ContentType, type WorkflowStatus } from './admin';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;
const num = (v: unknown) => Number(v) || 0;
const str = (v: unknown) => (v == null ? '' : String(v));
const TABLE: Record<ContentType, string> = {
  thread: 'forum_threads',
  reply: 'forum_replies',
  comment: 'comments',
};

export interface AdminNote {
  id: number;
  targetType: NoteTarget;
  targetId: string;
  body: string;
  author: string | null;
  createdAt: string;
}
export type NoteTarget = 'profile' | 'thread' | 'reply' | 'comment' | 'official';

export interface ContentVersion {
  id: number;
  title: string | null;
  body: string;
  editor: string | null;
  createdAt: string;
}

export interface UserProfileExtra {
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  /** 仅管理员可见；null = 未订阅或不可见 */
  subscription: { status: string; lang: string; confirmedAt: string | null } | null;
  subscriptionVisible: boolean;
  logins: { createdAt: string; updatedAt: string | null; ip: string | null; userAgent: string | null }[];
  tags: string[];
  posts: {
    kind: ContentType;
    id: string;
    title: string | null;
    excerpt: string;
    published: boolean;
    createdAt: string;
  }[];
  reportsFiled: {
    id: string;
    targetType: string;
    targetId: string;
    reason: string;
    status: string;
    createdAt: string;
  }[];
  reportsAgainst: {
    id: string;
    targetType: string;
    targetId: string;
    reason: string;
    status: string;
    createdAt: string;
  }[];
}

export interface CrmApi {
  notes(type: NoteTarget, id: string): Promise<AdminNote[]>;
  addNote(type: NoteTarget, id: string, body: string): Promise<AdminNote>;
  deleteNote(id: number): Promise<number>;
  userProfile(id: string): Promise<UserProfileExtra | null>;
  addTag(userId: string, tag: string): Promise<void>;
  removeTag(userId: string, tag: string): Promise<void>;
  setWorkflow(
    type: ContentType,
    ids: string[],
    status: WorkflowStatus,
    scheduledAt?: string | null,
  ): Promise<number>;
  workflowTick(): Promise<number>;
  versions(type: ContentType, id: string): Promise<ContentVersion[]>;
  contentBody(type: ContentType, id: string): Promise<{ title: string | null; body: string } | null>;
}

const arr = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);
export function toProfileExtra(p: Row | null): UserProfileExtra | null {
  if (!p) return null;
  const sub = p.subscription as Row | null;
  const rep = (x: Row) => ({
    id: str(x.id),
    targetType: str(x.target_type),
    targetId: str(x.target_id),
    reason: str(x.reason),
    status: str(x.status),
    createdAt: str(x.created_at),
  });
  return {
    lastSignInAt: (p.last_sign_in_at as string) ?? null,
    emailConfirmedAt: (p.email_confirmed_at as string) ?? null,
    subscription: sub
      ? { status: str(sub.status), lang: str(sub.lang), confirmedAt: (sub.confirmed_at as string) ?? null }
      : null,
    subscriptionVisible: !!p.subscription_visible,
    logins: arr(p.logins).map((x) => ({
      createdAt: str(x.created_at),
      updatedAt: (x.updated_at as string) ?? null,
      ip: (x.ip as string) ?? null,
      userAgent: (x.user_agent as string) ?? null,
    })),
    tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(str) : [],
    posts: arr(p.posts).map((x) => ({
      kind: str(x.kind) as ContentType,
      id: str(x.id),
      title: (x.title as string) ?? null,
      excerpt: str(x.excerpt),
      published: x.published !== false,
      createdAt: str(x.created_at),
    })),
    reportsFiled: arr(p.reports_filed).map(rep),
    reportsAgainst: arr(p.reports_against).map(rep),
  };
}

const NOTE_TYPES: NoteTarget[] = ['profile', 'thread', 'reply', 'comment', 'official'];
const toNote = (r: Row): AdminNote => ({
  id: num(r.id),
  targetType: str(r.target_type) as NoteTarget,
  targetId: str(r.target_id),
  body: str(r.body),
  author: (r.author as string) ?? null,
  createdAt: str(r.created_at),
});

export function createCrmApi({ rest }: AdminRest): CrmApi {
  const rpc = <T>(name: string, body: Record<string, unknown> = {}) =>
    rest<T>(`rpc/${name}`, { method: 'POST', body, requireAuth: true });
  const bulk = async (path: string, method: 'PATCH' | 'DELETE', body?: unknown) => {
    const rows = await rest<Row[]>(path, {
      method,
      body,
      prefer: 'return=representation',
      requireAuth: true,
    });
    return rows?.length ?? 0;
  };
  return {
    async notes(type, id) {
      if (!NOTE_TYPES.includes(type) || !id) return [];
      const rows = await rest<Row[]>(
        `admin_notes?target_type=eq.${type}&target_id=eq.${enc(id.slice(0, 200))}&select=*&order=created_at.desc&limit=100`,
        { requireAuth: true },
      );
      return (rows ?? []).map(toNote);
    },
    async addNote(type, id, body) {
      const text = body.trim().slice(0, 2000);
      if (!NOTE_TYPES.includes(type) || !id || !text) throw new Error('备注不能为空');
      const rows = await rest<Row[]>('admin_notes?select=*', {
        method: 'POST',
        body: { target_type: type, target_id: id.slice(0, 200), body: text },
        prefer: 'return=representation',
        requireAuth: true,
      });
      return toNote(rows[0]);
    },
    async deleteNote(id) {
      if (!Number.isInteger(id) || id < 1) return 0;
      return bulk(`admin_notes?id=eq.${id}&select=id`, 'DELETE');
    },
    async userProfile(id) {
      if (!UUID.test(id)) return null;
      return toProfileExtra(await rpc<Row | null>('mod_user_profile', { p_id: id }));
    },
    async addTag(userId, tag) {
      const t = tag.trim().slice(0, 24);
      if (!UUID.test(userId) || !t) return;
      await rest('admin_user_tags', {
        method: 'POST',
        body: { user_id: userId, tag: t },
        prefer: 'resolution=ignore-duplicates,return=minimal',
        requireAuth: true,
      });
    },
    async removeTag(userId, tag) {
      if (!UUID.test(userId)) return;
      await bulk(`admin_user_tags?user_id=eq.${userId}&tag=eq.${enc(tag)}&select=tag`, 'DELETE');
    },
    async setWorkflow(type, ids, status, scheduledAt = null) {
      const n = await rpc<number>('mod_set_workflow', {
        p_type: type,
        p_ids: uuidList(ids),
        p_status: status,
        p_scheduled_at:
          scheduledAt && !Number.isNaN(Date.parse(scheduledAt)) ? new Date(scheduledAt).toISOString() : null,
      });
      return num(n);
    },
    async workflowTick() {
      return num(await rpc<number>('mod_workflow_tick'));
    },
    async contentBody(type, id) {
      if (!UUID.test(id) || !TABLE[type]) return null;
      const rows = await rest<Row[]>(
        `${TABLE[type]}?id=eq.${id}&select=${type === 'thread' ? 'title,body' : 'body'}&limit=1`,
        { requireAuth: true },
      );
      const r = rows?.[0];
      return r ? { title: (r.title as string) ?? null, body: str(r.body) } : null;
    },
    async versions(type, id) {
      if (!UUID.test(id) || !TABLE[type]) return [];
      const rows = await rest<Row[]>(
        `content_versions?target_type=eq.${type}&target_id=eq.${id}&select=id,title,body,editor,created_at&order=created_at.desc&limit=50`,
        { requireAuth: true },
      );
      return (rows ?? []).map((r) => ({
        id: num(r.id),
        title: (r.title as string) ?? null,
        body: str(r.body),
        editor: (r.editor as string) ?? null,
        createdAt: str(r.created_at),
      }));
    },
  };
}
