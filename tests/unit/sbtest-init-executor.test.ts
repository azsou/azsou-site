/**
 * azsou-test 初始化执行器（scripts/sbtest/init-executor.mjs）——第五轮 ⑤ + 第六轮 ①②③。
 * 不连任何真实项目：Management API / Auth Admin / Storage 都由本文件里的有状态假服务器回答。
 * 测：ref 允许清单、钉住 SHA + sha256、dry-run 零网络、每文件事务外壳、超时后核对、不重试；
 *     第六轮：权限预检（403 列项目照常继续、名称 / ref / 区域不符拒绝）、injected 凭据通道（不带头、401 拒绝、主机允许清单）、
 *     V1 验收接入 execute（每项失败都非零）、超时清点、--resume、测试账号密码不进日志 / 记录。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXIT,
  MIGRATIONS,
  MGMT_INJECTED_BASE,
  NoInjection,
  PROD_REF,
  PROJECT_BASE,
  Refused,
  SYNTHETIC_USERS,
  TEST_REF,
  analyzeLedger,
  applyOne,
  assertRef,
  buildManifest,
  client,
  execute,
  expectedCounts,
  expectedObjects,
  main,
  preflight,
  preflightProblems,
  resolveEndpoints,
  runRecordMarkdown,
  syntheticFiles,
  verifyPinned,
  verifyTarget,
  wrapMigration,
} from '../../scripts/sbtest/init-executor.mjs';

const SHA = 'a'.repeat(40);
const FILES = Object.fromEntries(
  MIGRATIONS.map((n) => [
    `db/migrations/${n}_m.sql`,
    Buffer.from(`-- ${n}\nbegin;\ncreate table t${n} (x int);\ncommit;\n`),
  ]),
);
FILES['db/verify/status.sql'] = Buffer.from("select '0002' as step, 'x' as item, true as ok;\n");
const read = (rel: string) =>
  FILES[rel] ??
  (() => {
    throw new Error(`no ${rel}`);
  })();
const list = () => MIGRATIONS.map((n) => `${n}_m.sql`);
const IMPACT = JSON.parse(readFileSync('ops/sbtest/init-impact.json', 'utf8'));
const MANIFEST = buildManifest(SHA, read, list);
const FAKE_MG = 'http://127.0.0.1:9';
const FAKE_PJ = 'http://127.0.0.1:10';

type Obj = { name: string; body: Buffer };
type State = {
  project: Record<string, unknown>;
  listStatus: number;
  listRefs: string[];
  azInit: boolean;
  ledger: { run_id: string; file: string; sha256: string }[];
  users: { email: string; id: string; key: string }[];
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
};
const fresh = (o: Partial<State> = {}): State => ({
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
  ...o,
});

/**
 * 有状态假服务器（Management API + Auth Admin + Storage）。
 * hooks.onQuery / onUser / onUpload 可以注入失败、超时；calls 记录 url / 方法 / 头 / 正文。
 */
function fakeApi(
  st: State,
  hooks: {
    onQuery?: (q: string) => Response | Promise<Response> | undefined;
    onReadOnly?: (q: string) => unknown;
    onUser?: (body: { email: string }) => Response | undefined;
    onUpload?: (p: string) => Response | undefined;
    unauthorized?: (url: string) => boolean;
  } = {},
) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
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
    });
    if (hooks.unauthorized?.(url)) return new Response('no auth', { status: 401 });
    const u = new URL(url);
    const p = u.pathname;
    if (p === `/v1/projects/${TEST_REF}`) return Response.json(st.project);
    if (p === '/v1/projects')
      return st.listStatus === 200
        ? Response.json(st.listRefs.map((ref) => ({ ref })))
        : new Response('forbidden', { status: st.listStatus });
    const q = p.includes('/database/query') && init.body ? JSON.parse(String(init.body)).query : '';
    if (p.endsWith('/database/query/read-only')) {
      const o = hooks.onReadOnly?.(q);
      if (o instanceof Response) return o;
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
    if (p === '/auth/v1/admin/users') {
      const body = JSON.parse(String(init.body));
      const h = hooks.onUser?.(body);
      if (h) return h;
      const id = crypto.randomUUID();
      st.users.push({
        email: body.email,
        id,
        key: SYNTHETIC_USERS.find((x: { email: string }) => x.email === body.email)!.key,
      });
      return Response.json({ id });
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
    if (p === '/auth/v1/settings') return new Response('no apikey', { status: 401 });
    if (p === '/storage/v1/bucket') return Response.json([]);
    return new Response('?', { status: 404 });
  };
  return { calls, fetchImpl: f as unknown as typeof fetch };
}

/** 假只读端点：按执行器 SQL 的别名回答当前状态 */
function answer(st: State, q: string): Record<string, unknown> {
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
          confirmed: true,
          role: st.roleOverride[u.email] ?? (st.seeded ? s!.role : 'user'),
          banned: st.seeded && !!s!.banned,
          providers: ['email'],
          active_ban: st.seeded && !!s!.banned,
        };
      }),
    };
  if (q.includes('as accounts')) return { accounts: st.users.map((u) => ({ email: u.email, id: u.id })) };
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

const mk = (st: State, hooks = {}, trace: unknown[] = []) => {
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
const run = (c: ReturnType<typeof client>, o: Record<string, unknown> = {}) =>
  execute({ sha: SHA, manifest: MANIFEST, impact: IMPACT, c, runId: 'r1', read, log: () => {}, ...o });

describe('ref 允许清单', () => {
  it('只有 azsou-test', () => {
    expect(() => assertRef(TEST_REF)).not.toThrow();
    expect(() => assertRef(PROD_REF)).toThrow(/生产/);
    expect(() => assertRef('aaaaaaaaaaaaaaaaaaaa')).toThrow(Refused);
    expect(() =>
      client({
        mode: 'env-token',
        token: 't',
        serviceKey: 'k',
        mgmtBase: FAKE_MG,
        projectBase: FAKE_PJ,
        ref: PROD_REF,
      }),
    ).toThrow(/生产/);
  });
});

describe('钉住 SHA + sha256', () => {
  const m = MANIFEST;
  it('清单列出 0001–0019 各自的 sha256', () => {
    expect(m.migrations.map((x: { name: string }) => x.name.slice(0, 4))).toEqual([...MIGRATIONS]);
    expect(m.source_sha).toBe(SHA);
  });
  it('内容一致 → 通过；任何一个文件被改 → 拒绝', () => {
    expect(() => verifyPinned(m, SHA, read, list)).not.toThrow();
    const tampered = (rel: string) =>
      rel.includes('0007') ? Buffer.from('begin;\ndrop table x;\ncommit;\n') : read(rel);
    expect(() => verifyPinned(m, SHA, tampered, list)).toThrow(/0007/);
  });
  it('SHA 与清单钉住的不同 → 拒绝；不是 40 位 → 拒绝', () => {
    expect(() => verifyPinned(m, 'b'.repeat(40), read, list)).toThrow(/钉住/);
    expect(() => buildManifest('abc', undefined, list)).toThrow(/40 位/);
  });
  it('多一个 / 少一个迁移文件 → 拒绝', () => {
    expect(() => buildManifest(SHA, read, () => [...list(), '0020_x.sql'])).toThrow(/0001–0019/);
    expect(() => buildManifest(SHA, read, () => list().slice(1))).toThrow(/0001–0019/);
  });
  it('钉住的提交不在本地 git 对象库（浅克隆）→ 拒绝并提示先 fetch', () => {
    const absent = '0'.repeat(40);
    expect(() => buildManifest(absent)).toThrow(Refused);
    expect(() => buildManifest(absent)).toThrow(/不在本地 git 对象库/);
  });
});

describe('每个文件一个事务 + 超时 + 账本', () => {
  it('去掉文件自带的 begin / commit，换成带超时与账本行的单事务', () => {
    const w = wrapMigration(read('db/migrations/0003_m.sql'), {
      name: '0003_m.sql',
      sha: 'f'.repeat(64),
      runId: 'r1',
    });
    expect(w.match(/^begin;$/gm)).toHaveLength(1);
    expect(w.match(/^commit;$/gm)).toHaveLength(1);
    expect(w).toMatch(/set local statement_timeout = '300s'/);
    expect(w).toMatch(/insert into az_init\.applied .*'r1', '0003_m\.sql'/);
  });
  it('文件结构不是单个 begin…commit → 拒绝（不猜）', () => {
    expect(() =>
      wrapMigration(Buffer.from('create table x();\n'), { name: 'x', sha: '', runId: 'r' }),
    ).toThrow(Refused);
    expect(() =>
      wrapMigration(Buffer.from('begin;\nbegin;\ncommit;\n'), { name: 'x', sha: '', runId: 'r' }),
    ).toThrow(Refused);
  });
});

describe('第六轮 ② 凭据通道：injected（默认）/ env-token（只给本机假服务器）', () => {
  it('injected 默认基址 = api.supabase.io + 测试项目主机；api.supabase.com / 生产 ref / 其他主机一律拒绝', () => {
    expect(resolveEndpoints({})).toEqual({
      mode: 'injected',
      mgmtBase: MGMT_INJECTED_BASE,
      projectBase: PROJECT_BASE,
    });
    expect(() => resolveEndpoints({ mgmtBase: 'https://api.supabase.com' })).toThrow(/生产 PAT 连接器/);
    expect(() => resolveEndpoints({ mgmtBase: 'https://evil.example' })).toThrow(/只允许/);
    expect(() => resolveEndpoints({ projectBase: `https://${PROD_REF}.supabase.co` })).toThrow(/生产/);
    expect(() => resolveEndpoints({ projectBase: 'https://other.supabase.co' })).toThrow(/只允许/);
  });
  it('env-token 只允许回环地址：拿真实令牌指向真实主机 → 拒绝', () => {
    expect(() =>
      resolveEndpoints({ mode: 'env-token', mgmtBase: MGMT_INJECTED_BASE, projectBase: FAKE_PJ }),
    ).toThrow(/回环/);
    expect(() =>
      resolveEndpoints({ mode: 'env-token', mgmtBase: 'https://api.supabase.com', projectBase: FAKE_PJ }),
    ).toThrow(/生产 PAT/);
    expect(resolveEndpoints({ mode: 'env-token', mgmtBase: FAKE_MG, projectBase: FAKE_PJ }).mgmtBase).toBe(
      FAKE_MG,
    );
  });
  it('injected 模式不接受进程内令牌；CLI 环境里有 SBTEST_MGMT_TOKEN → 拒绝', async () => {
    expect(() => client({ mode: 'injected', token: 't' })).toThrow(/不接受进程内令牌/);
    const err = console.error;
    console.error = () => {};
    const code = await main(['preflight'], { SBTEST_MGMT_TOKEN: 'x' });
    console.error = err;
    expect(code).toBe(EXIT.REFUSED);
  });
  it('injected 模式发出的请求不带 Authorization / apikey 头', async () => {
    const st = fresh();
    const api = fakeApi(st);
    // injected 只允许真实主机：用 fetchImpl 截住，不出网
    const c = client({ fetchImpl: api.fetchImpl });
    await preflight(c);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((x) => x.url.startsWith(MGMT_INJECTED_BASE))).toBe(true);
    expect(api.calls.some((x) => 'authorization' in x.headers || 'apikey' in x.headers)).toBe(false);
  });
  it('线路上没注入（401）→ NoInjection 拒绝，不继续发后面的请求', async () => {
    const st = fresh();
    const api = fakeApi(st, { unauthorized: () => true });
    const c = client({ fetchImpl: api.fetchImpl });
    await expect(preflight(c)).rejects.toThrow(NoInjection);
    expect(api.calls).toHaveLength(1);
    const st2 = fresh();
    const api2 = fakeApi(st2, { unauthorized: (u) => u.includes('/auth/v1/') });
    const c2 = client({ fetchImpl: api2.fetchImpl });
    // 管理面已注入、项目面 Auth 没注入：迁移跑完到 U1 时拒绝（exit 2，不是失败、不重试），附打码清点
    const r = await run(c2);
    expect(r.exit).toBe(EXIT.REFUSED);
    expect(r.refused).toMatch(/401/);
    expect(r.inventory.items.ledger).toHaveLength(19);
    expect(api2.calls.filter((x) => x.url.includes('/auth/v1/admin/users'))).toHaveLength(1);
  });
  it('运行记录只有方法 / 路径 / 状态 / 耗时，不含令牌', async () => {
    const trace: { path: string }[] = [];
    const { c } = mk(fresh(), {}, trace);
    const pre = await preflight(c);
    const md = runRecordMarkdown({
      title: 't',
      when: 'now',
      mode: 'env-token',
      endpoints: c.endpoints,
      pre,
      trace,
      verdict: 'ok',
    });
    expect(md).not.toMatch(/SECRET|Bearer|apikey:/);
    expect(md).toMatch(/\| GET \| \/v1\/projects\/ovvfwkmqlejcpatmfqcd \| 200 \|/);
    expect(md).toMatch(/project-scoped/);
    expect(md).not.toContain('10.1.2.3');
  });
});

describe('第六轮 ① 权限预检：固定目标身份，不要求列项目', () => {
  it('GET /v1/projects → 403：记为 project-scoped，照常继续', async () => {
    const { c } = mk(fresh({ listStatus: 403 }));
    const r = await verifyTarget(c);
    expect(r.scope.list_projects).toBe(403);
    expect(r.scope.verdict).toMatch(/project-scoped/);
    expect(r.target.organization_id).not.toBe('org1234567890');
  });
  it('名称 / ref / 区域任何一项不符 → 拒绝；状态不是 ACTIVE_HEALTHY → 拒绝', async () => {
    for (const bad of [
      { name: 'azsou' },
      { ref: 'bbbbbbbbbbbbbbbbbbbb', id: 'bbbbbbbbbbbbbbbbbbbb' },
      { region: 'us-east-1' },
      { status: 'PAUSED' },
    ]) {
      const st = fresh();
      st.project = { ...st.project, ...bad };
      const { c } = mk(st);
      await expect(verifyTarget(c)).rejects.toThrow(Refused);
    }
  });
  it('列项目 200 且看得到生产或别的项目 → 拒绝；只看得到 azsou-test → 通过', async () => {
    await expect(
      verifyTarget(mk(fresh({ listStatus: 200, listRefs: [TEST_REF, PROD_REF] })).c),
    ).rejects.toThrow(/生产/);
    await expect(
      verifyTarget(mk(fresh({ listStatus: 200, listRefs: [TEST_REF, 'b'.repeat(20)] })).c),
    ).rejects.toThrow(/2 个项目/);
    expect((await verifyTarget(mk(fresh({ listStatus: 200 })).c)).scope.list_projects).toBe(200);
  });
  it('C0：非空 / 有 cron / 有 az_init → 预检问题，execute 拒绝且一个写请求都不发', async () => {
    expect(preflightProblems({ server_version: '17', auth_users: 3, public_relations: 2 })).toHaveLength(2);
    expect(preflightProblems({ server_version: '17', cron_extension: true })).toHaveLength(1);
    const st = fresh({ publicTables: 1 });
    const { api, c } = mk(st);
    await expect(run(c)).rejects.toThrow(/预检不通过/);
    expect(api.calls.some((x) => x.url.endsWith('/database/query'))).toBe(false);
  });
});

describe('超时 / 断线后先核对是否提交，不重试', () => {
  const m = { name: '0005_m.sql', sha256: 'f'.repeat(64) };
  const sql = read('db/migrations/0005_m.sql');
  const withVerify = (ledger: number, running: number) =>
    mk(fresh(), {
      onQuery: () => {
        throw new Error('client-timeout');
      },
      onReadOnly: (q: string) => (q.includes('as v') ? { v: { ledger, running } } : undefined),
    }).c;
  it('超时但账本有行 → 已提交', async () => {
    expect((await applyOne(withVerify(1, 0), m, sql, 'r')).outcome).toBe('committed');
  });
  it('超时且账本没有行、也没在跑 → 未提交', async () => {
    expect((await applyOne(withVerify(0, 0), m, sql, 'r')).outcome).toBe('not-committed');
  });
  it('超时且会话还在跑 → still-running（不重试）', async () => {
    expect((await applyOne(withVerify(0, 1), m, sql, 'r')).outcome).toBe('still-running');
  });
  it('执行中途某个文件失败 → 停在那里（exit 1），后面的文件不发，附打码清点', async () => {
    const queries: string[] = [];
    const st = fresh();
    const { c } = mk(st, {
      onQuery: (q: string) => {
        queries.push(q);
        return q.includes('0004_m.sql') ? new Response('boom', { status: 400 }) : undefined;
      },
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.FAILED);
    expect(queries.some((q) => q.includes('0005_m.sql'))).toBe(false);
    expect(r.inventory.status).toBe('determined');
    expect(r.inventory.items.ledger.map((x: { file: string }) => x.file)).toEqual([
      '0001_m.sql',
      '0002_m.sql',
      '0003_m.sql',
    ]);
  });
  it('超时且核对不出结果 → exit 3，清点状态 unknown，不重试同一文件', async () => {
    const st = fresh();
    let sent0006 = 0;
    const { c } = mk(st, {
      onQuery: (q: string) => {
        if (q.includes('0006_m.sql')) {
          sent0006++;
          throw new Error('client-timeout');
        }
        return undefined;
      },
      onReadOnly: (q: string) => (q.includes('as v') ? new Response('gateway', { status: 504 }) : undefined),
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(sent0006).toBe(1);
    expect(r.inventory.status).toBe('unknown');
    expect(r.results.at(-1).outcome).toBe('unknown');
  });
  it('建账号超时 → exit 3（unknown），清点列出已建账号（id 打码）', async () => {
    const st = fresh();
    const { c } = mk(st, {
      onUser: (b: { email: string }) => {
        if (b.email.startsWith('sbtest-moderator')) throw new Error('client-timeout');
        return undefined;
      },
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(r.inventory.status).toBe('unknown');
    const acc = r.inventory.items.accounts;
    expect(acc).toHaveLength(1);
    expect(acc[0].id).not.toBe(st.users[0].id);
    expect(acc[0].id).toMatch(/…/);
  });
});

describe('第六轮 ③ V1 验收接入 execute：只有全部通过才 exit 0', () => {
  it('全部成功 → exit 0，7 项 V1 全过；账号经 Auth Admin API、文件经 Storage API、重新下载核对', async () => {
    const st = fresh();
    const { api, c } = mk(st);
    const r = await run(c);
    expect(r.exit).toBe(EXIT.OK);
    expect(r.v1.checks.map((x: { id: string }) => x.id)).toEqual([
      'V1.cron',
      'V1.status',
      'V1.objects',
      'V1.ledger',
      'V1.accounts',
      'V1.seed',
      'V1.storage',
    ]);
    expect(r.v1.checks.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(st.ledger).toHaveLength(20);
    expect(api.calls.filter((x) => x.url.includes('/auth/v1/admin/users'))).toHaveLength(4);
    expect(
      api.calls.filter((x) => x.url.includes('/storage/v1/object/authenticated/ugc-images/')),
    ).toHaveLength(2);
    expect(api.calls.map((x) => x.body).join('\n')).not.toMatch(/insert into auth\.(users|identities)/i);
  });
  const cases: [string, (st: State) => Record<string, unknown> | void, string][] = [
    [
      'cron 被启用',
      () => {
        // 执行后才出现 cron（C0 时没有）
        let n = 0;
        return {
          onReadOnly: (q: string) =>
            q.includes('as preflight') && ++n > 1
              ? { preflight: { cron_extension: true, cron_schema: true, cron_jobs: 1 } }
              : undefined,
        };
      },
      'V1.cron',
    ],
    [
      'status.sql 有未生效项',
      () => {
        let n = 0;
        return {
          onReadOnly: (q: string) =>
            q.includes('as rows') && !q.includes('step <=') && ++n
              ? { rows: [{ step: '0019', item: 'x', ok: false }] }
              : undefined,
        };
      },
      'V1.status',
    ],
    ['影响清单里的对象缺失', (st) => void (st.missingObjects = 3), 'V1.objects'],
    [
      '账本 sha256 不符',
      (st) => ({
        onQuery: (q: string) =>
          q.includes("'0009_m.sql'")
            ? (st.ledger.push({ run_id: 'r1', file: '0009_m.sql', sha256: 'bad' }),
              Response.json([], { status: 201 }))
            : undefined,
      }),
      'V1.ledger',
    ],
    ['账号角色不对', (st) => void (st.roleOverride['sbtest-moderator@example.com'] = 'user'), 'V1.accounts'],
    ['种子行数不对', (st) => void (st.countsDelta['public.forum_threads'] = 1), 'V1.seed'],
    ['重新下载 sha256 不符', (st) => void (st.corruptDownload = true), 'V1.storage'],
  ];
  for (const [label, setup, id] of cases)
    it(`${label} → exit 1（${id} 不通过），附清点`, async () => {
      const st = fresh();
      const hooks = setup(st) ?? {};
      const { c } = mk(st, hooks);
      const r = await run(c);
      expect(r.exit).toBe(EXIT.FAILED);
      expect(r.v1.checks.find((x: { id: string }) => x.id === id).ok).toBe(false);
      expect(r.inventory).toBeDefined();
    });
});

describe('第六轮 ③ --resume：按账本续跑，不一致就拒绝', () => {
  const ledgerUpTo = (n: number, runId = 'old1') =>
    MANIFEST.migrations
      .slice(0, n)
      .map((m: { name: string; sha256: string }) => ({ run_id: runId, file: m.name, sha256: m.sha256 }));
  it('analyzeLedger：严格前缀 → 下一个位置；sha 不符 / 乱序 / 未知条目 / 多个 run_id / seed 早于迁移 → 拒绝', () => {
    expect(analyzeLedger(ledgerUpTo(7), MANIFEST)).toEqual({ runId: 'old1', next: 7, seedDone: false });
    const badSha = ledgerUpTo(3);
    badSha[2].sha256 = 'x';
    expect(() => analyzeLedger(badSha, MANIFEST)).toThrow(/sha256/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { run_id: 'old1', file: '9999_x.sql', sha256: 'y' }], MANIFEST),
    ).toThrow(/未知/);
    expect(() => analyzeLedger([ledgerUpTo(2)[1]], MANIFEST)).toThrow(/未知/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { ...ledgerUpTo(3)[2], run_id: 'other' }], MANIFEST),
    ).toThrow(/多个 run_id/);
    expect(() =>
      analyzeLedger([...ledgerUpTo(2), { run_id: 'old1', file: 'seed', sha256: 'z' }], MANIFEST),
    ).toThrow(/矛盾/);
    expect(() => analyzeLedger(null, MANIFEST)).toThrow(/没有 az_init/);
  });
  it('账本到 0007 → 从 0008 续跑（沿用原 run_id），完成后 V1 全过', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(7) });
    const queries: string[] = [];
    const { c } = mk(st, { onQuery: (q: string) => void queries.push(q) });
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    expect(r.runId).toBe('old1');
    expect(queries.some((q) => q.includes('0007_m.sql'))).toBe(false);
    expect(queries.some((q) => q.includes('0008_m.sql'))).toBe(true);
    expect(queries.some((q) => q.includes('create schema if not exists az_init'))).toBe(false);
  });
  it('种子未提交但已有部分合成账号 → 拒绝（需人工处理），不发写请求', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: [{ email: 'sbtest-admin@example.com', id: crypto.randomUUID(), key: 'admin' }],
    });
    const { api, c } = mk(st);
    await expect(run(c, { resume: true })).rejects.toThrow(/部分建号需人工处理/);
    expect(api.calls.some((x) => x.url.endsWith('/database/query') || x.url.includes('/admin/users'))).toBe(
      false,
    );
  });
  it('种子已提交、文件缺 1 个 → 只补传缺的那个，再 V1', async () => {
    const st = fresh();
    const { c } = mk(st);
    // 先完整跑一遍得到真实状态，再删掉一个对象模拟「F1 中途断」
    expect((await run(c)).exit).toBe(EXIT.OK);
    st.objects.pop();
    const { api, c: c2 } = mk(st);
    const r = await run(c2, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    expect(
      api.calls.filter((x) => x.method === 'POST' && x.url.includes('/storage/v1/object/ugc-images/')),
    ).toHaveLength(1);
    expect(api.calls.some((x) => x.url.includes('/admin/users'))).toBe(false);
  });
  it('已存在的对象内容不符 → 拒绝（不覆盖）', async () => {
    const st = fresh();
    expect((await run(mk(st).c)).exit).toBe(EXIT.OK);
    st.objects[0].body = Buffer.from('tampered');
    const { api, c } = mk(st);
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.REFUSED);
    expect(r.refused).toMatch(/内容不符/);
    expect(
      api.calls.some((x) => x.method === 'POST' && x.url.includes('/storage/v1/object/ugc-images/')),
    ).toBe(false);
  });
  it('还有 az-init 会话在跑 → 拒绝；没有账本 → 拒绝；全新执行遇到已有 az_init → 拒绝并提示 --resume', async () => {
    await expect(
      run(mk(fresh({ azInit: true, ledger: ledgerUpTo(3), running: 1 })).c, { resume: true }),
    ).rejects.toThrow(/会话在运行/);
    await expect(run(mk(fresh()).c, { resume: true })).rejects.toThrow(/az_init 不存在/);
    await expect(run(mk(fresh({ azInit: true, ledger: ledgerUpTo(3) })).c)).rejects.toThrow(/--resume/);
  });
});

describe('第六轮 ③ 测试账号凭据：密码由执行器生成，不进日志 / 运行记录 / 清点', () => {
  it('默认 discard：密码只出现在 Admin API 请求体里；handoff 通道拿到 4 个各不相同的密码', async () => {
    const st = fresh();
    const logs: string[] = [];
    const trace: unknown[] = [];
    const got: Record<string, string> = {};
    const { api, c } = mk(st, {}, trace);
    const r = await execute({
      sha: SHA,
      manifest: MANIFEST,
      impact: IMPACT,
      c,
      runId: 'r1',
      read,
      log: (s: string) => logs.push(s),
      handoff: { write: (e: string, p: string) => void (got[e] = p) },
    });
    expect(r.exit).toBe(EXIT.OK);
    const pw = api.calls
      .filter((x) => x.url.includes('/admin/users'))
      .map((x) => JSON.parse(x.body).password);
    expect(new Set(pw).size).toBe(4);
    expect(Object.values(got).sort()).toEqual([...pw].sort());
    const blob = JSON.stringify({ logs, trace, r });
    for (const p of pw) expect(blob).not.toContain(p);
  });
});

describe('CLI dry-run', () => {
  it('plan 不发任何网络请求（fetch 被替换成会抛错的哨兵）', async () => {
    const orig = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called++;
      throw new Error('NETWORK');
    }) as typeof fetch;
    try {
      const log = console.log;
      console.log = () => {};
      const code = await main(['plan']);
      console.log = log;
      expect(code).toBe(EXIT.OK);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
  it('execute 缺站长批准 / 确认 ref 不对 → 拒绝（exit 2）', async () => {
    const err = console.error;
    console.error = () => {};
    expect(await main(['execute', '--execute', '--confirm-ref', PROD_REF], {})).toBe(EXIT.REFUSED);
    expect(await main(['execute', '--execute', '--confirm-ref', TEST_REF], {})).toBe(EXIT.REFUSED);
    console.error = err;
  });
  it('syntheticFiles 两个对象 sha256 不同', () => {
    const f = syntheticFiles();
    expect(f[0].sha256).not.toBe(f[1].sha256);
  });
});
