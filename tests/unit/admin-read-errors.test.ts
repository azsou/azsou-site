/**
 * A15 / T091（单元层）：后台读取失败按原因分类，旧库降级读取。
 * 根因复现：生产库只有 V72 基线（0002–0017 均未执行），PostgREST 对后台 RPC / 表回 404 PGRST202 / PGRST205；
 * 修复前这类错误与断网同样显示「网络或服务暂时不可用」。这里用假 fetch 逐类覆盖，真实 PostgREST 证据见
 * tests/e2e/admin-read.spec.ts（本地 Postgres + PostgREST，库结构 = 0001 生产基线 / 0001–0016）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRepository, memoryStore, type Session } from '@/lib/data';
import { adminApiFor } from '@/lib/data/admin-repo';
import { DataUnavailableError, ForbiddenError, SchemaMissingError } from '@/lib/data/types';
import { OBJECT_MIGRATION, objectFromPath } from '@/lib/data/schema-map';
import { describeAdminError, adminErrorLine } from '@/lib/admin-errors';
import { friendlyError } from '@/lib/community-errors';

type Call = { url: string; method: string; body: unknown };
type Reply = { status?: number; json?: unknown; throws?: Error; hang?: boolean };
function fakeFetch(routes: [RegExp, (c: Call) => Reply][]) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      url: decodeURIComponent(String(input)),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    const r: Reply = hit ? hit[1](c) : { status: 404, json: { message: 'no route' } };
    if (r.throws) throw r.throws;
    if (r.hang)
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    return new Response(JSON.stringify(r.json ?? null), { status: r.status ?? 200 });
  });
  return { f: f as unknown as typeof fetch, calls };
}
const session: Session = {
  accessToken: 'jwt-admin',
  refreshToken: 'r',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u-admin', email: 'a@x.com', emailConfirmed: true, provider: 'email' },
};
const repoWith = (routes: Parameters<typeof fakeFetch>[0], timeoutMs?: number) => {
  const ff = fakeFetch(routes);
  const repo = createSupabaseRepository({
    url: 'https://x.supabase.co',
    key: 'pk',
    fetch: ff.f,
    store: memoryStore(session),
    timeoutMs,
  });
  return { admin: adminApiFor(repo)!, calls: ff.calls };
};
/** 生产库实测的错误体（docs/audits/evidence/batch1/prod-anon-probe.txt） */
const PGRST202 = (fn: string) => ({
  status: 404,
  json: {
    code: 'PGRST202',
    message: `Could not find the function public.${fn} without parameters in the schema cache`,
  },
});
const PGRST205 = (t: string) => ({
  status: 404,
  json: { code: 'PGRST205', message: `Could not find the table 'public.${t}' in the schema cache` },
});

describe('A15 错误分类', () => {
  it('缺 RPC（PGRST202）→ SchemaMissingError，带对象名与迁移编号；提示不再说「网络」', async () => {
    const { admin } = repoWith([[/rpc\/admin_stats/, () => PGRST202('admin_stats')]]);
    const err = await admin.stats().catch((e) => e);
    expect(err).toBeInstanceOf(SchemaMissingError);
    expect(err).toBeInstanceOf(DataUnavailableError); // 旧代码按父类处理不受影响
    expect(err).toMatchObject({ object: 'admin_stats', migration: '0009', code: 'PGRST202', kind: 'schema' });
    const info = describeAdminError(err);
    expect(info.kind).toBe('schema');
    expect(info.title).toContain('admin_stats');
    expect(info.text).toContain('迁移 0009');
    expect(`${info.title}${info.text}`).not.toMatch(/网络或服务暂时不可用/);
    expect(info.retryLabel).toBe('重新检测');
  });

  it('缺表（PGRST205）：举报 / 审计 → 0003；留言 / 友链 → 0015；订阅 → 0016', async () => {
    const { admin } = repoWith([
      [/reports\?/, () => PGRST205('reports')],
      [/audit_log\?/, () => PGRST205('audit_log')],
    ]);
    await expect(admin.listReports()).rejects.toMatchObject({ object: 'reports', migration: '0003' });
    await expect(admin.audit()).rejects.toMatchObject({ object: 'audit_log', migration: '0003' });
    expect(OBJECT_MIGRATION.guestbook_entries).toBe('0015');
    expect(OBJECT_MIGRATION.admin_list_friend_links).toBe('0015');
    expect(OBJECT_MIGRATION.admin_subscriber_counts).toBe('0016');
  });

  it('断网 → network；超时 → timeout；5xx → server；403 → permission；四者文案互不相同', async () => {
    const net = repoWith([[/rpc\/admin_stats/, () => ({ throws: new TypeError('Failed to fetch') })]]);
    const slow = repoWith([[/rpc\/admin_stats/, () => ({ hang: true })]], 20);
    const down = repoWith([[/rpc\/admin_stats/, () => ({ status: 503, json: { message: 'upstream' } })]]);
    const deny = repoWith([
      [/rpc\/admin_stats/, () => ({ status: 403, json: { code: '42501', message: 'x' } })],
    ]);
    const kinds = await Promise.all(
      [net, slow, down, deny].map((r) => r.admin.stats().catch((e) => describeAdminError(e))),
    );
    expect(kinds.map((k) => (k as { kind: string }).kind)).toEqual([
      'network',
      'timeout',
      'server',
      'permission',
    ]);
    expect(new Set(kinds.map((k) => (k as { title: string }).title)).size).toBe(4);
    expect(await deny.admin.stats().catch((e) => e)).toBeInstanceOf(ForbiddenError);
  });

  it('旧签名（库在 0016，缺 0017 的 p_sort）：内容 / 用户列表去掉排序参数重读，并标记降级', async () => {
    const { admin, calls } = repoWith([
      [
        /rpc\/mod_list_(content|users)/,
        (c) =>
          (c.body as Record<string, unknown>).p_sort !== undefined
            ? PGRST202('mod_list_content')
            : { json: [{ id: 'x', kind: 'thread', title: 't', total: 1, display_name: 'u' }] },
      ],
    ]);
    const r = await admin.listContent({ type: 'thread', sort: 'title', dir: 'asc' });
    expect(r.items).toHaveLength(1);
    expect(r.degraded).toEqual({ feature: '服务端排序', migration: '0017' });
    expect(calls.map((c) => 'p_sort' in (c.body as object))).toEqual([true, false]);
    const u = await admin.listUsers({ sort: 'role', dir: 'desc' });
    expect(u.degraded?.migration).toBe('0017');
    // 不排序时只请求一次，不降级
    const plain = await admin.listContent({ type: 'thread' });
    expect(plain.degraded).toBeUndefined();
  });

  it('旧签名也不存在（库在 0001）→ 仍报缺 0009，不吞错', async () => {
    const { admin, calls } = repoWith([[/rpc\/mod_list_content/, () => PGRST202('mod_list_content')]]);
    await expect(admin.listContent({ type: 'thread', sort: 'title' })).rejects.toMatchObject({
      object: 'mod_list_content',
      migration: '0009',
    });
    expect(calls).toHaveLength(2);
  });

  it('一行文案：toast 用；公开页面的 friendlyError 行为不变', () => {
    const e = new SchemaMissingError('admin_stats', 'PGRST202', '0009');
    expect(adminErrorLine(e)).toMatch(/^数据库未就绪：缺少「admin_stats」：/);
    expect(friendlyError(new DataUnavailableError())).toBe('网络或服务暂时不可用，请检查网络后重试。');
  });
});

describe('对象 → 迁移 对照表与迁移文件一致', () => {
  const dir = join(import.meta.dirname, '../../db/migrations');
  const files = Object.fromEntries(
    ['0003', '0004', '0008', '0009', '0012', '0015', '0016', '0017'].map((n) => {
      const name = readdirSync(dir).find((x) => x.startsWith(n))!;
      return [n, readFileSync(join(dir, name), 'utf8')];
    }),
  );
  for (const [obj, mig] of Object.entries(OBJECT_MIGRATION))
    it(`${obj} 由 ${mig} 创建`, () => {
      expect(files[mig]).toMatch(
        new RegExp(`create (or replace )?(function|table|view) (if not exists )?public\\.${obj}\\b`, 'i'),
      );
    });
  it('路径 → 对象名', () => {
    expect(objectFromPath('rpc/admin_stats')).toBe('admin_stats');
    expect(objectFromPath('reports?select=*&limit=1')).toBe('reports');
  });
});
