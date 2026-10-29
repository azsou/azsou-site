/**
 * azsou-test 初始化执行器测试用的有状态假服务器（Management API + Auth Admin + Storage），第七轮抽出共用。
 * 不连任何真实项目。hooks 可以注入失败、超时、重定向、错误形状。
 */
import { readFileSync } from 'node:fs';
import * as X from '../../scripts/sbtest/init-executor.mjs';

const { MIGRATIONS, SYNTHETIC_USERS, TEST_REF, buildManifest, client, expectedCounts, expectedObjects } =
  X as any;

/**
 * 第九轮 / 第十轮：只有经 CLI main 读钉住的迁移、真正大量起 git 子进程（cat-file / show / ls-tree，每个用例 42–128 次）的用例单独放宽到 30s；
 * 纯逻辑用例、以及只起 2 次 git 的「钉住的提交不在本地」用例保持 vitest 默认 5s（不再整文件 vi.setConfig）。
 * 第十一轮：sbtest-init-r11 里 4 个起真实 CLI 子进程（node scripts/sbtest/init-executor.mjs，回环假服务器）的用例同样按用例 30s；其纯逻辑用例默认 5s。
 * 耗时是单实例、非空闲（共享 HEAVY.lock 下，宿主 load1 约 4–6，2 vCPU）实测，不是空闲机器：见
 * docs/audits/evidence/sbtest/round9-2026-10-29.md 与 round10-2026-10-29.md。
 */
export const SPAWN_TIMEOUT = 30_000;
export const SHA = 'a'.repeat(40);
export const FILES: Record<string, Buffer<ArrayBuffer>> = Object.fromEntries(
  (MIGRATIONS as string[]).map((n) => [
    `db/migrations/${n}_m.sql`,
    Buffer.from(`-- ${n}\nbegin;\ncreate table t${n} (x int);\ncommit;\n`),
  ]),
);
FILES['db/verify/status.sql'] = Buffer.from("select '0002' as step, 'x' as item, true as ok;\n");
export const read = (rel: string) =>
  FILES[rel] ??
  (() => {
    throw new Error(`no ${rel}`);
  })();
export const list = () => (MIGRATIONS as string[]).map((n) => `${n}_m.sql`);
export const IMPACT = JSON.parse(readFileSync('ops/sbtest/init-impact.json', 'utf8'));
export const MANIFEST = buildManifest(SHA, read, list);
export const FAKE_MG = 'http://127.0.0.1:9';
export const FAKE_PJ = 'http://127.0.0.1:10';

export type User = {
  email: string;
  id: string;
  key: string;
  confirmed?: boolean;
  name?: string;
  run?: string | null;
  providers?: string[];
  password?: string;
};
type Obj = { name: string; body: Buffer };
export type State = {
  project: Record<string, unknown>;
  listStatus: number;
  listRefs: string[];
  azInit: boolean;
  ledger: { run_id: string; file: string; sha256: string }[];
  users: User[];
  seeded: boolean;
  objects: Obj[];
  cron: boolean;
  statusBad: string[];
  missingObjects: number;
  countsDelta: Record<string, number>;
  roleOverride: Record<string, string>;
  corruptDownload: boolean;
  running: number;
  publicTables: number;
  /** GET /auth/v1/admin/users 的回答（第七轮 ① 项目服务准入） */
  adminList: { status: number; body: unknown; raw?: string };
};
export const fresh = (o: Partial<State> = {}): State => ({
  project: {
    ref: TEST_REF,
    id: TEST_REF,
    name: 'azsou-test',
    region: 'ap-southeast-1',
    status: 'ACTIVE_HEALTHY',
    organization_id: 'org1234567890',
  },
  listStatus: 403,
  listRefs: [TEST_REF],
  azInit: false,
  ledger: [],
  users: [],
  seeded: false,
  objects: [],
  cron: false,
  statusBad: [],
  missingObjects: 0,
  countsDelta: {},
  roleOverride: {},
  corruptDownload: false,
  running: 0,
  publicTables: 0,
  adminList: { status: 200, body: { users: [], aud: 'authenticated' } },
  ...o,
});

export type Hooks = {
  onQuery?: (q: string) => Response | Promise<Response> | undefined;
  onReadOnly?: (q: string) => unknown;
  onUser?: (body: { email: string }) => Response | undefined;
  onUpload?: (p: string) => Response | undefined;
  unauthorized?: (url: string) => boolean;
  /** 任意请求先经过这里（返回 Response 即直接回答），用来模拟重定向等 */
  any?: (url: string, init: RequestInit) => Response | undefined;
};
export type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect?: string;
};

export function fakeApi(st: State, hooks: Hooks = {}) {
  const calls: Call[] = [];
  const ledgerInsert =
    /insert into az_init\.applied \(run_id, file, sha256\) values \('([^']+)', '([^']+)', '([^']+)'\)/;
  const f = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : '',
      redirect: init.redirect,
    });
    const pre = hooks.any?.(url, init);
    if (pre) return pre;
    if (hooks.unauthorized?.(url)) return new Response('no auth', { status: 401 });
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? 'GET';
    if (p === `/v1/projects/${TEST_REF}`) return Response.json(st.project);
    if (p === '/v1/projects')
      return st.listStatus === 200
        ? Response.json(st.listRefs.map((ref) => ({ ref })))
        : new Response('forbidden', { status: st.listStatus });
    const q = p.includes('/database/query') && init.body ? JSON.parse(String(init.body)).query : '';
    if (p.endsWith('/database/query/read-only')) {
      const o = hooks.onReadOnly?.(q);
      if (o instanceof Response) return o;
      // 返回 Promise（例如 Promise.reject(new TypeError('fetch failed'))）= 模拟网络层结果，原样交给调用方
      if (o && typeof (o as Promise<unknown>).then === 'function') return o as Promise<Response>;
      if (o !== undefined) return Response.json([o], { status: 201 });
      return Response.json([answer(st, q)], { status: 201 });
    }
    if (p.endsWith('/database/query')) {
      const h = await hooks.onQuery?.(q);
      if (h) return h;
      if (q.includes('create schema if not exists az_init')) {
        st.azInit = true;
        return Response.json([], { status: 201 });
      }
      const m = q.match(ledgerInsert);
      if (m) {
        st.ledger.push({ run_id: m[1], file: m[2], sha256: m[3] });
        if (m[2] === 'seed') st.seeded = true;
      }
      return Response.json([], { status: 201 });
    }
    if (p === '/auth/v1/admin/users' && method === 'GET') {
      const a = st.adminList;
      if (a.raw !== undefined) return new Response(a.raw, { status: a.status });
      return Response.json(a.body, { status: a.status });
    }
    if (p === '/auth/v1/admin/users' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      const h = hooks.onUser?.(body);
      if (h) return h;
      if (st.users.some((x) => x.email === body.email))
        return Response.json({ code: 'email_exists' }, { status: 422 });
      const id = crypto.randomUUID();
      st.users.push({
        email: body.email,
        id,
        key: SYNTHETIC_USERS.find((x: { email: string }) => x.email === body.email)!.key,
        confirmed: body.email_confirm === true,
        name: body.user_metadata?.name,
        run: body.app_metadata?.az_init_run ?? null,
        providers: ['email'],
        password: body.password,
      });
      return Response.json({ id, email: body.email });
    }
    const put = p.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
    if (put && method === 'PUT') {
      const usr = st.users.find((x) => x.id === put[1]);
      if (!usr) return new Response('not found', { status: 404 });
      const body = JSON.parse(String(init.body));
      if (body.password) usr.password = body.password;
      return Response.json({ id: usr.id, email: usr.email });
    }
    if (p.startsWith('/storage/v1/object/ugc-images/')) {
      const name = decodeURIComponent(p.slice('/storage/v1/object/ugc-images/'.length));
      const h = hooks.onUpload?.(name);
      if (h) return h;
      st.objects.push({ name, body: Buffer.from(init.body as Uint8Array) });
      return Response.json({ Key: name });
    }
    if (p.startsWith('/storage/v1/object/authenticated/ugc-images/')) {
      const name = decodeURIComponent(p.slice('/storage/v1/object/authenticated/ugc-images/'.length));
      const o = st.objects.find((x) => x.name === name);
      if (!o) return new Response('not found', { status: 404 });
      return new Response(
        new Uint8Array(st.corruptDownload ? Buffer.concat([o.body, Buffer.from('x')]) : o.body),
      );
    }
    if (p === '/auth/v1/settings') return Response.json({ external: { email: true } });
    if (p === '/storage/v1/bucket') return Response.json([]);
    return new Response('?', { status: 404 });
  };
  return { calls, fetchImpl: f as unknown as typeof fetch };
}

/** 假只读端点：按执行器 SQL 的别名回答当前状态 */
export function answer(st: State, q: string): Record<string, unknown> {
  if (q.includes('as identity'))
    return {
      identity: {
        current_database: 'postgres',
        current_user: 'supabase_read_only_user',
        version: 'PostgreSQL 17.6',
        server_addr: '10.1.2.3',
        server_port: 5432,
        in_recovery: false,
      },
    };
  if (q.includes('as preflight'))
    return {
      preflight: {
        server_version: '17.6',
        public_relations: st.publicTables,
        public_functions: 0,
        private_schema: false,
        az_init_schema: st.azInit,
        supabase_migrations_schema: false,
        cron_extension: st.cron,
        cron_schema: st.cron,
        cron_jobs: 0,
        pg_net_extension: false,
        auth_users: st.users.length,
        auth_identities: st.users.length,
        auth_sessions: 0,
        auth_refresh_tokens: 0,
        storage_buckets: 0,
        storage_objects: st.objects.length,
        extensions: ['plpgsql'],
      },
    };
  if (q.includes('as v')) return { v: { ledger: 0, running: st.running } };
  if (q.includes('as ledger')) return { ledger: st.azInit ? st.ledger : null };
  if (q.includes('as n')) return { n: st.running };
  if (q.includes('as accounts') && q.includes('active_ban'))
    return {
      accounts: st.users.map((u) => {
        const s = SYNTHETIC_USERS.find((x: { email: string }) => x.email === u.email);
        return {
          email: u.email,
          id: u.id,
          confirmed: u.confirmed ?? true,
          role: st.roleOverride[u.email] ?? (st.seeded ? s!.role : 'user'),
          banned: st.seeded && !!s!.banned,
          providers: u.providers ?? ['email'],
          active_ban: st.seeded && !!s!.banned,
        };
      }),
    };
  if (q.includes('as accounts'))
    return {
      accounts: st.users.map((u) => ({
        email: u.email,
        id: u.id,
        confirmed: u.confirmed ?? true,
        name: u.name ?? SYNTHETIC_USERS.find((x: { email: string }) => x.email === u.email)?.name,
        run: u.run === undefined ? null : u.run,
        providers: u.providers ?? ['email'],
      })),
    };
  if (q.includes('as counts')) {
    const exp = expectedCounts(IMPACT);
    const out: Record<string, number> = {};
    for (const k of Object.keys(exp)) out[k] = (st.seeded ? exp[k] : 0) + (st.countsDelta[k] ?? 0);
    return { counts: out };
  }
  if (q.includes("bucket_id = 'ugc-images'"))
    return { objects: st.objects.map((o) => ({ name: o.name, size: o.body.length })) };
  if (q.includes("kind || '|'")) {
    const all = [...expectedObjects(IMPACT), 'extension|-|pg_trgm'];
    return { objects: all.slice(st.missingObjects) };
  }
  if (q.includes('as rows'))
    return {
      rows: st.statusBad.length ? st.statusBad.map((s) => ({ step: s, item: 'x', ok: false })) : null,
    };
  return {};
}

export const mk = (st: State, hooks: Hooks = {}, trace: unknown[] = []) => {
  const api = fakeApi(st, hooks);
  const c = client({
    mode: 'env-token',
    token: 'tok-SECRET',
    serviceKey: 'svc-SECRET',
    mgmtBase: FAKE_MG,
    projectBase: FAKE_PJ,
    fetchImpl: api.fetchImpl,
    trace,
  });
  return { api, c };
};
export const run = (c: unknown, o: Record<string, unknown> = {}) =>
  (X as any).execute({
    sha: SHA,
    manifest: MANIFEST,
    impact: IMPACT,
    c,
    runId: 'r1',
    read,
    log: () => {},
    ...o,
  });
export const writes = (calls: Call[]) =>
  calls.filter(
    (x) =>
      x.url.endsWith('/database/query') ||
      (x.url.includes('/auth/v1/admin/users') && x.method !== 'GET') ||
      (x.url.includes('/storage/v1/object/') && x.method !== 'GET'),
  );
