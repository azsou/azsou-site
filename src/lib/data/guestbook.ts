/**
 * 留言板（T7.3）与友链（T7.4）的数据接口（迁移 0015）。直接调 PostgREST，不引 supabase-js；
 * 写入走本站 /api/submit/<kind>（Turnstile 服务端校验 + 票据），审核走 RPC。权限全部在数据库。
 * 单独一个模块：只有留言板 / 友链 / 后台这几页的包里带它。
 */
import { restError, schemaMissing } from './supabase';
import { DataUnavailableError, NotSignedInError, ValidationError } from './types';
import { supabaseConfig } from '../supabase-config';
import { getRepository } from './index';
import type { GuestbookInput, LinkInput, SubmitKind } from '../community-forms';

export type ModStatus = 'pending' | 'approved' | 'rejected';

export interface GuestbookEntry {
  id: string;
  nickname: string;
  body: string;
  status: ModStatus;
  createdAt: string;
}
export interface FriendLink {
  id: string;
  name: string;
  url: string;
  description: string;
  status: ModStatus;
  createdAt: string;
  /** 只有管理员接口返回 */
  contact?: string;
}

export interface GuestbookApi {
  listEntries(opts?: {
    offset?: number;
    limit?: number;
  }): Promise<{ items: GuestbookEntry[]; total: number }>;
  listLinks(): Promise<FriendLink[]>;
  submit(kind: SubmitKind, input: GuestbookInput | LinkInput, captchaToken: string): Promise<void>;
  /** 版主 / 管理员：按状态列出留言（RLS 让他们读到全部状态） */
  modEntries(
    status: ModStatus | 'all',
    opts?: { offset?: number; limit?: number },
  ): Promise<{
    items: GuestbookEntry[];
    total: number;
  }>;
  modSetEntries(ids: string[], status: ModStatus): Promise<number>;
  modDeleteEntries(ids: string[]): Promise<number>;
  /** 管理员：友链申请（含联系方式） */
  adminLinks(status: ModStatus | 'all'): Promise<FriendLink[]>;
  adminSetLinks(ids: string[], status: ModStatus): Promise<number>;
  adminDeleteLinks(ids: string[]): Promise<number>;
  /** 管理员：邮件订阅数量（按状态 × 语言；0016 不提供任何列出邮箱的接口） */
  subscriberCounts(): Promise<SubscriberCount[]>;
}

export interface SubscriberCount {
  status: 'pending' | 'confirmed' | 'unsubscribed';
  lang: 'zh' | 'en';
  n: number;
}

export interface GuestbookConfig {
  url: string;
  key: string;
  token: () => Promise<string | null>;
  /** 本站提交端点（默认 /api/submit） */
  submitEndpoint?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 本站提交接口返回的错误（status + 中文 msg） */
export class SubmitError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

type Row = Record<string, unknown>;
const toEntry = (r: Row): GuestbookEntry => ({
  id: String(r.id),
  nickname: String(r.nickname ?? ''),
  body: String(r.body ?? ''),
  status: (r.status as ModStatus) ?? 'approved',
  createdAt: String(r.created_at),
});
const toLink = (r: Row): FriendLink => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  url: String(r.url ?? ''),
  description: String(r.description ?? ''),
  status: (r.status as ModStatus) ?? 'approved',
  createdAt: String(r.created_at),
  ...(typeof r.contact === 'string' ? { contact: r.contact } : {}),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (list: string[]) => {
  const ok = list.filter((x) => UUID.test(x));
  if (!ok.length) throw new ValidationError('没有选中任何条目');
  return ok;
};
/** 公开 approved 只要「一页 + 总数」：Content-Range 0-19/57 */
const totalOf = (res: Response, fallback: number) => {
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  return m ? Number(m[1]) : fallback;
};

export function createGuestbookApi(cfg: GuestbookConfig): GuestbookApi {
  const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = cfg.submitEndpoint ?? '/api/submit';

  async function rest(
    path: string,
    init: { method?: string; body?: unknown; count?: boolean; auth?: 'required' } = {},
  ): Promise<{ json: unknown; res: Response }> {
    const token = await cfg.token().catch(() => null);
    if (init.auth === 'required' && !token) throw new NotSignedInError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8000);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        apikey: cfg.key,
        Authorization: `Bearer ${token ?? cfg.key}`,
      };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      if (init.count) headers.Prefer = 'count=exact';
      res = await f(`${cfg.url}/rest/v1/${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new DataUnavailableError((e as Error)?.message, {
        kind: ctrl.signal.aborted ? 'timeout' : 'network',
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok)
        throw new DataUnavailableError('响应不是 JSON', { kind: 'bad-response', status: res.status });
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code;
      // 缺 RPC / 表 = 留言板 / 订阅迁移（0015 / 0016）没执行：明确报「缺哪个对象」（A15），不归为网络问题
      if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883')
        throw schemaMissing(path, code);
      throw restError(res.status, json as Record<string, unknown>);
    }
    return { json, res };
  }
  const rpc = async (name: string, body: Record<string, unknown>) =>
    (await rest(`rpc/${name}`, { method: 'POST', body, auth: 'required' })).json;
  const page = (o?: { offset?: number; limit?: number }) => {
    const limit = Math.min(Math.max(o?.limit ?? 20, 1), 100);
    const offset = Math.max(o?.offset ?? 0, 0);
    return { limit, offset, q: `&limit=${limit}&offset=${offset}` };
  };
  const ENTRY_COLS = 'id,nickname,body,status,created_at';

  return {
    async listEntries(o) {
      const p = page(o);
      const { json, res } = await rest(
        `guestbook_entries?select=${ENTRY_COLS}&status=eq.approved&order=created_at.desc,id.desc${p.q}`,
        { count: true },
      );
      const rows = (json as Row[]) ?? [];
      return { items: rows.map(toEntry), total: totalOf(res, rows.length) };
    },
    async listLinks() {
      const { json } = await rest(
        'friend_links?select=id,name,url,description,status,created_at&status=eq.approved&order=created_at.asc,id.asc&limit=500',
      );
      return ((json as Row[]) ?? []).map(toLink);
    },
    async submit(kind, input, captchaToken) {
      let res: Response;
      try {
        res = await f(`${endpoint}/${kind}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, captchaToken }),
        });
      } catch (e) {
        throw new DataUnavailableError((e as Error)?.message);
      }
      if (res.ok) return;
      let j: { error_code?: string; msg?: string; field?: string } = {};
      try {
        j = await res.json();
      } catch {
        /* 非 JSON（例如本站没有部署 Function 时的 404 页面） */
      }
      throw new SubmitError(
        res.status,
        j.error_code ?? 'unknown',
        j.msg || '提交失败，请稍后再试。',
        j.field,
      );
    },
    async modEntries(status, o) {
      const p = page(o);
      const filter = status === 'all' ? '' : `&status=eq.${status}`;
      const { json, res } = await rest(
        `guestbook_entries?select=${ENTRY_COLS}${filter}&order=created_at.desc,id.desc${p.q}`,
        { count: true, auth: 'required' },
      );
      const rows = (json as Row[]) ?? [];
      return { items: rows.map(toEntry), total: totalOf(res, rows.length) };
    },
    async modSetEntries(list, status) {
      return Number(await rpc('mod_guestbook_set_status', { p_ids: ids(list), p_status: status })) || 0;
    },
    async modDeleteEntries(list) {
      return Number(await rpc('mod_guestbook_delete', { p_ids: ids(list) })) || 0;
    },
    async adminLinks(status) {
      const rows = (await rpc('admin_list_friend_links', {
        p_status: status === 'all' ? null : status,
      })) as Row[];
      return (rows ?? []).map(toLink);
    },
    async adminSetLinks(list, status) {
      return Number(await rpc('admin_friend_link_set_status', { p_ids: ids(list), p_status: status })) || 0;
    },
    async adminDeleteLinks(list) {
      return Number(await rpc('admin_friend_link_delete', { p_ids: ids(list) })) || 0;
    },
    async subscriberCounts() {
      const rows = (await rpc('admin_subscriber_counts', {})) as Row[];
      return (rows ?? []).map((r) => ({
        status: r.status as SubscriberCount['status'],
        lang: r.lang as SubscriberCount['lang'],
        n: Number(r.n) || 0,
      }));
    },
  };
}

let api: GuestbookApi | null = null;
/** 浏览器端入口：与仓储共用同一个登录会话 */
export function getGuestbook(): GuestbookApi {
  if (api) return api;
  const repo = getRepository();
  api = createGuestbookApi({
    ...supabaseConfig(),
    token: () => repo.auth.accessToken(),
  });
  return api;
}
