import type { AuthUser, Session } from './types';

/**
 * 会话存储。浏览器里用 localStorage，键名与格式沿用 V72（az-session-v68），
 * 所以 V72 与 v2 在同一域名下共享登录状态，切换版本不需要重新登录。
 */
export interface SessionStore {
  get(): Session | null;
  /** raw = GoTrue 原始 user 对象（V72 读取 user.user_metadata 等字段） */
  set(s: Session | null, raw?: Record<string, unknown>): void;
}

export const SESSION_KEY = 'az-session-v68';

/** GoTrue 返回的 user 对象 → AuthUser */
export function toAuthUser(u: Record<string, unknown> | null | undefined): AuthUser | null {
  if (!u || typeof u.id !== 'string') return null;
  const app = (u.app_metadata ?? {}) as Record<string, unknown>;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: u.id,
    email: typeof u.email === 'string' && u.email ? u.email : null,
    emailConfirmed: !!(u.email_confirmed_at || u.confirmed_at),
    provider: typeof app.provider === 'string' ? app.provider : 'email',
    metaName: (meta.name as string) || (meta.full_name as string) || (meta.user_name as string) || null,
  };
}

/** V72 存储格式 ↔ Session */
interface StoredV68 {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

export function fromStored(raw: unknown): Session | null {
  const s = raw as StoredV68 | null;
  if (!s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return null;
  const user = toAuthUser(s.user);
  if (!user) return null;
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: Number(s.expires_at) || 0,
    user,
  };
}

export function toStored(s: Session, rawUser?: Record<string, unknown>): StoredV68 {
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    expires_at: s.expiresAt,
    user: rawUser ?? {
      id: s.user.id,
      email: s.user.email,
      email_confirmed_at: s.user.emailConfirmed ? new Date(0).toISOString() : null,
      app_metadata: { provider: s.user.provider },
      user_metadata: s.user.metaName ? { name: s.user.metaName } : {},
    },
  };
}

export function memoryStore(initial: Session | null = null): SessionStore {
  let cur = initial;
  return {
    get: () => cur,
    set: (s) => {
      cur = s;
    },
  };
}

export function localStore(key = SESSION_KEY): SessionStore {
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    get() {
      try {
        return fromStored(JSON.parse(ls()?.getItem(key) ?? 'null'));
      } catch {
        return null;
      }
    },
    set(s, raw) {
      const store = ls();
      if (!store) return;
      if (!s) store.removeItem(key);
      else {
        // 保留 V72 写进去的原始 user / profile 字段
        let prev: StoredV68 | null;
        try {
          prev = JSON.parse(store.getItem(key) ?? 'null');
        } catch {
          prev = null;
        }
        const keepUser = prev && (prev.user as { id?: string })?.id === s.user.id ? prev.user : undefined;
        store.setItem(key, JSON.stringify(toStored(s, raw ?? keepUser)));
      }
    },
  };
}
