/**
 * Supabase Auth（GoTrue）适配器：直接调 /auth/v1 REST，不引 supabase-js（首屏 JS 预算）。
 * 换认证后端时实现同一个 AuthProvider 接口即可。
 */
import { fromStored, toAuthUser, type SessionStore } from './session';
import {
  AuthError,
  DataUnavailableError,
  type AuthProvider,
  type CallbackResult,
  type CallbackType,
  type OAuthProvider,
  type Session,
  type SignUpInput,
} from './types';

export interface SupabaseAuthConfig {
  url: string;
  key: string;
  store: SessionStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * 需要人机验证的动作（注册 / 找回密码 / 重发确认邮件）改走站内 Vercel Function：
   * 先在服务端校验 Turnstile，再由服务端转发给 GoTrue。不设置时直接请求 GoTrue。
   */
  guardedEndpoint?: string;
  /** PKCE verifier 存放（默认 localStorage） */
  verifierStore?: { get(): string | null; set(v: string | null): void };
}

/** GoTrue error_code → 给用户看的中文 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: '邮箱或密码不正确。',
  invalid_grant: '邮箱或密码不正确。',
  email_not_confirmed: '邮箱还没有验证：请先点击确认邮件里的链接，或在下方重新发送。',
  user_already_exists: '这个邮箱已经注册过了，可以直接登录或找回密码。',
  email_exists: '这个邮箱已经注册过了，可以直接登录或找回密码。',
  weak_password: '密码太弱：至少 8 位，并同时包含字母和数字。',
  same_password: '新密码不能与当前密码相同。',
  over_email_send_rate_limit: '邮件发送太频繁，请稍后再试。',
  over_request_rate_limit: '请求太频繁，请稍后再试。',
  captcha_failed: '人机验证没有通过，请重试。',
  turnstile_failed: '人机验证没有通过，请重试。',
  turnstile_not_configured: '人机验证尚未配置，暂时无法注册，请联系站长。',
  signup_disabled: '暂未开放注册。',
  email_provider_disabled: '暂未开放邮箱注册。',
  provider_disabled: '这种登录方式尚未启用。',
  email_address_invalid: '邮箱地址不正确。',
  validation_failed: '填写的信息格式不正确。',
  otp_expired: '链接已失效或已被使用，请重新发送。',
  flow_state_expired: '登录流程已过期，请重新开始。',
  flow_state_not_found: '登录流程已失效，请在同一个浏览器里重新开始。',
  bad_code_verifier: '登录流程已失效，请在同一个浏览器里重新开始。',
  refresh_token_not_found: '登录已过期，请重新登录。',
  refresh_token_already_used: '登录已过期，请重新登录。',
  session_not_found: '登录已过期，请重新登录。',
  user_banned: '这个账号已被停用。',
  access_denied: '你取消了授权，或授权没有通过。',
};

export function authErrorFrom(status: number, body: Record<string, unknown> | null): AuthError {
  const code = String(body?.error_code ?? body?.code ?? body?.error ?? 'unknown');
  const raw = String(body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? '');
  let msg = MESSAGES[code];
  if (!msg && /invalid login credentials/i.test(raw)) msg = MESSAGES.invalid_credentials;
  if (!msg && /email not confirmed/i.test(raw)) msg = MESSAGES.email_not_confirmed;
  if (!msg && /already registered/i.test(raw)) msg = MESSAGES.user_already_exists;
  if (!msg && /password should/i.test(raw)) msg = MESSAGES.weak_password;
  if (!msg && status === 429) msg = MESSAGES.over_request_rate_limit;
  return new AuthError(msg || raw || `请求失败（HTTP ${status}）`, code, status);
}

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const rnd = new Uint8Array(48);
  crypto.getRandomValues(rnd);
  const verifier = b64url(rnd);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

const localVerifier = {
  get: () => {
    try {
      return localStorage.getItem('az-pkce-verifier');
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem('az-pkce-verifier', v);
      else localStorage.removeItem('az-pkce-verifier');
    } catch {
      /* 隐私模式 */
    }
  },
};

export function createSupabaseAuth(cfg: SupabaseAuthConfig): AuthProvider {
  const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const verifiers = cfg.verifierStore ?? localVerifier;
  const listeners = new Set<(s: Session | null) => void>();
  const emit = (s: Session | null) => listeners.forEach((l) => l(s));

  async function call(
    path: string,
    init: { method?: string; body?: unknown; token?: string | null; base?: string } = {},
  ): Promise<Record<string, unknown> | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 10000);
    let res: Response;
    try {
      res = await f(`${init.base ?? `${cfg.url}/auth/v1`}/${path}`, {
        method: init.method ?? 'POST',
        headers: {
          apikey: cfg.key,
          'content-type': 'application/json',
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DataUnavailableError((e as Error)?.message);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Record<string, unknown> | null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      if (res.status >= 500) throw new DataUnavailableError(`HTTP ${res.status}`);
      throw authErrorFrom(res.status, json);
    }
    return json;
  }

  function saveTokens(j: Record<string, unknown>): Session {
    const user = toAuthUser(j.user as Record<string, unknown>);
    if (!user || typeof j.access_token !== 'string')
      throw new AuthError('登录响应不完整，请重试。', 'bad_response', 500);
    const s: Session = {
      accessToken: j.access_token,
      refreshToken: String(j.refresh_token ?? ''),
      expiresAt: Number(j.expires_at) || Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
      user,
    };
    cfg.store.set(s, j.user as Record<string, unknown>);
    emit(s);
    return s;
  }

  let refreshing: Promise<Session | null> | null = null;
  async function refresh(s: Session): Promise<Session | null> {
    refreshing ??= call('token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } })
      .then((j) => saveTokens(j ?? {}))
      .catch((e) => {
        if (e instanceof AuthError) {
          cfg.store.set(null);
          emit(null);
          return null;
        }
        return s; // 网络问题：先用旧 token，交给 RLS 判断
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function accessToken(): Promise<string | null> {
    const s = cfg.store.get();
    if (!s) return null;
    if (s.expiresAt - 60 > Math.floor(Date.now() / 1000)) return s.accessToken;
    return (await refresh(s))?.accessToken ?? null;
  }

  async function guarded(action: 'signup' | 'recover' | 'resend', body: Record<string, unknown>) {
    if (!cfg.guardedEndpoint) return null;
    return call(action, { body, base: cfg.guardedEndpoint });
  }

  const captchaMeta = (token?: string) => (token ? { gotrue_meta_security: { captcha_token: token } } : {});
  const q = (redirectTo?: string) => (redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '');

  return {
    getSession: () => cfg.store.get(),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    accessToken,
    async signUp(input: SignUpInput) {
      const payload = {
        email: input.email.trim(),
        password: input.password,
        data: { name: input.displayName.trim() },
      };
      const j =
        (await guarded('signup', {
          ...payload,
          captchaToken: input.captchaToken,
          redirectTo: input.redirectTo,
        })) ??
        (await call(`signup${q(input.redirectTo)}`, {
          body: { ...payload, ...captchaMeta(input.captchaToken) },
        }));
      if (j && typeof j.access_token === 'string')
        return { session: saveTokens(j), needsConfirmation: false };
      return { session: null, needsConfirmation: true };
    },
    async signIn(email, password) {
      const j = await call('token?grant_type=password', { body: { email: email.trim(), password } });
      return saveTokens(j ?? {});
    },
    async signOut() {
      const s = cfg.store.get();
      cfg.store.set(null);
      emit(null);
      if (s) await call('logout?scope=local', { token: s.accessToken }).catch(() => undefined);
    },
    async requestPasswordReset(email, opts = {}) {
      const body = { email: email.trim() };
      if (await guarded('recover', { ...body, captchaToken: opts.captchaToken, redirectTo: opts.redirectTo }))
        return;
      await call(`recover${q(opts.redirectTo)}`, { body: { ...body, ...captchaMeta(opts.captchaToken) } });
    },
    async resendConfirmation(email, opts = {}) {
      const body = { type: 'signup', email: email.trim() };
      if (await guarded('resend', { ...body, captchaToken: opts.captchaToken, redirectTo: opts.redirectTo }))
        return;
      await call(`resend${q(opts.redirectTo)}`, { body: { ...body, ...captchaMeta(opts.captchaToken) } });
    },
    async updatePassword(password) {
      const token = await accessToken();
      if (!token) throw new AuthError('登录已过期，请重新打开重置邮件里的链接。', 'session_not_found', 401);
      const u = await call('user', { method: 'PUT', body: { password }, token });
      const s = cfg.store.get();
      if (s && u) {
        const user = toAuthUser(u) ?? s.user;
        const next = { ...s, user };
        cfg.store.set(next, u);
        emit(next);
      }
    },
    async oauthUrl(provider: OAuthProvider, redirectTo: string) {
      const { verifier, challenge } = await pkcePair();
      verifiers.set(verifier);
      const p = new URLSearchParams({
        provider,
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: 's256',
      });
      if (provider === 'google') p.set('scopes', 'openid email profile');
      return `${cfg.url}/auth/v1/authorize?${p}`;
    },
    async handleCallback(url: URL): Promise<CallbackResult> {
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      const query = url.searchParams;
      const get = (k: string) => hash.get(k) ?? query.get(k);
      const type = (get('type') as CallbackType) ?? null;
      const err = get('error_code') ?? get('error');
      if (err) {
        const e = authErrorFrom(400, {
          error_code: get('error_code') ?? get('error'),
          msg: get('error_description') ?? '',
        });
        return { session: null, type, error: e.message };
      }
      try {
        // 1) PKCE：OAuth 回跳 ?code=
        const code = query.get('code');
        if (code) {
          const verifier = verifiers.get();
          verifiers.set(null);
          if (!verifier) throw new AuthError(MESSAGES.flow_state_not_found, 'flow_state_not_found');
          const j = await call('token?grant_type=pkce', {
            body: { auth_code: code, code_verifier: verifier },
          });
          return { session: saveTokens(j ?? {}), type: type ?? 'oauth' };
        }
        // 2) 自定义邮件模板：?token_hash=&type=
        const tokenHash = query.get('token_hash');
        if (tokenHash && type) {
          const j = await call('verify', { body: { type, token_hash: tokenHash } });
          return { session: j?.access_token ? saveTokens(j) : null, type };
        }
        // 3) 默认邮件模板（implicit）：#access_token=…&refresh_token=…&type=signup|recovery
        const access = hash.get('access_token');
        if (access) {
          const u = await call('user', { method: 'GET', token: access });
          return {
            session: saveTokens({
              access_token: access,
              refresh_token: hash.get('refresh_token') ?? '',
              expires_at: hash.get('expires_at'),
              expires_in: hash.get('expires_in'),
              user: u,
            }),
            type: type ?? 'magiclink',
          };
        }
        return {
          session: cfg.store.get(),
          type,
          error: cfg.store.get() ? undefined : '链接不完整或已失效。',
        };
      } catch (e) {
        return { session: null, type, error: (e as Error).message };
      }
    },
  };
}

/** 只读本地会话（Header 用户菜单在每一页都要用；不引整个适配器） */
export function readStoredSession(key = 'az-session-v68'): Session | null {
  try {
    return fromStored(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
}
