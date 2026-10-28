import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import pg from 'pg';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { forwardRest, seedThread, uniq } from './community-fixtures';
import { ADMIN_READ_MODULES, SHELL_ENDPOINTS, type AdminReadModuleId } from './admin-modules';
import { SHIM, createDatabase, dbUrl, dropDatabase, migrationFiles } from '../db/helpers';
import { BIN, ensureAuthenticator, freePort, schemaCacheLoads, startPostgrest, tok } from '../db/postgrest';

/**
 * A15 真实服务故障注入（站长 2026-10-27 要求；只在本机隔离环境，绝不连生产）。
 *
 * 与 admin-read.spec 的区别：那里的「断网 / 503」是在浏览器里用 route.abort / route.fulfill 伪造的；
 * 这里是真的服务端故障——独立数据库 + 两个真实 PostgREST 14 进程 + 一个本机 HTTP 代理：
 *   浏览器 /rest/v1/* ──(Playwright 转发)──► 本机代理 ──► /profiles → PostgREST A（始终在线，管理员身份检查用）
 *                                                    └─► 其余全部 → PostgREST B（故障目标）
 * 五种故障，每种对 8 个后台模块逐个：注入 → 打开模块 → 断言分类错误（data-error-kind + 文案）→ 恢复 → 点「重试 / 重新检测」→ 真实数据回来、错误消失。
 *   1. 停掉 PostgREST B 进程（SIGTERM）→ 连接被拒 → network「无法连接数据服务」；恢复 = 同端口重启进程
 *   2. 代理返回 503（模拟网关 / 上游不可用）→ server「服务端出错（HTTP 503）」
 *   3. 删除函数（把模块用到的 RPC 全部重命名，等价于 DROP 且可还原；表 / 视图同理）+ NOTIFY pgrst 重载结构
 *      → PostgREST 真实回 404 PGRST202（RPC）/ PGRST205（表）→ schema「数据库未就绪」，按钮「重新检测」
 *   4. 撤销授权（REVOKE EXECUTE / SELECT FROM PUBLIC, anon, authenticated）→ PostgREST 真实回 403 42501 → permission「没有权限」；恢复 = 按原 ACL 逐条 GRANT 回去
 *   5. 代理延迟 12s（前端请求超时 8s）→ timeout「请求超时」
 * 管理员身份检查（/profiles）走 A：本文件验的是「数据服务坏了时各模块怎么说」。整套 PostgREST 都挂时后台门禁的表现另见 PR 说明。
 * EVIDENCE_DIR 设置时保存内容管理页 network / permission / timeout 三种状态截图。
 */

const DB = `azsou_e2e_faults_${process.pid}`;
const SLOW_MS = 12_000;
type Mode = 'pass' | '503' | 'slow';
let mode: Mode = 'pass';
let pgA: ChildProcess | null = null;
let pgB: ChildProcess | null = null;
let portA = 0;
let portB = 0;
/** PostgREST B 的管理端口（/metrics 上的结构缓存加载计数 = 重载完成信号，故障 3 用） */
let adminB = 0;
let proxyPort = 0;
let proxy: http.Server | null = null;
let pool: pg.Pool | null = null;
const db = () => (pool ??= new pg.Pool({ connectionString: dbUrl(DB), max: 3 }));

/** 8 个模块：唯一清单在 admin-modules.ts（与交接文档、真实后台侧栏逐项核对） */
const MODULES = ADMIN_READ_MODULES;
type ModuleId = AdminReadModuleId;
/** 健康状态下每个模块实际请求的数据端点（不含 /profiles 与公开设置），由第一条用例记录 */
const endpoints = new Map<ModuleId, Set<string>>();
/** 每个端点在基线里的第一次真实请求（方法 + 路径查询 + 请求体），故障 3 原样重放来判断 PostgREST B 的结构缓存状态 */
type Call = { method: string; path: string; body: string | null };
const calls = new Map<ModuleId, Map<string, Call>>();

let admin: { id: string; email: string; name: string; token: string };
let threadTitle = '';

test.describe.configure({ mode: 'serial' });

// eslint-disable-next-line no-empty-pattern -- 不依赖其他夹具
test.beforeAll(async ({}, info) => {
  if (!process.env.DATABASE_URL || !BIN || info.project.name !== 'chromium-desktop') return;
  info.setTimeout(120_000);
  await createDatabase(DB, [SHIM, ...migrationFiles()]);
  await ensureAuthenticator();
  portA = await freePort();
  portB = await freePort();
  adminB = await freePort();
  pgA = await startPostgrest(DB, portA);
  pgB = await startPostgrest(DB, portB, { adminPort: adminB });
  proxy = http.createServer((req, res) => {
    const toA = /^\/profiles(\?|$)/.test(req.url ?? '');
    if (!toA && mode === '503') {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"message":"upstream unavailable (local fault injection)"}');
      return;
    }
    const go = () => {
      const up = http.request(
        {
          host: '127.0.0.1',
          port: toA ? portA : portB,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      // 上游进程不在：把连接直接断掉（不编造响应），Playwright 转发失败 → 浏览器得到连接被拒
      up.on('error', () => req.socket.destroy());
      req.pipe(up);
    };
    if (!toA && mode === 'slow') setTimeout(go, SLOW_MS);
    else go();
  });
  await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', () => r()));
  proxyPort = (proxy.address() as { port: number }).port;

  const id = randomUUID();
  admin = { id, email: `${id.slice(0, 8)}@example.com`, name: uniq('故障管理员'), token: tok(id) };
  await db().query(
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`,
    [id, admin.email, { name: admin.name }],
  );
  await db().query(`update public.profiles set role = 'admin' where id = $1`, [id]);
  threadTitle = uniq('故障注入主题 ');
  const tid = await seedThread(db(), id, { title: threadTitle });
  await db().query(
    `insert into public.reports (reporter, target_type, target_id, reason, detail) values ($1, 'thread', $2, 'spam', '故障注入合成举报')`,
    [id, tid],
  );
});

test.afterAll(async () => {
  // 同一 worker 可能对多个项目各跑一次 afterAll：每样资源只释放一次
  proxy?.close();
  proxy = null;
  pgA?.kill();
  pgB?.kill();
  pgA = pgB = null;
  const p = pool;
  pool = null;
  await p?.end();
  if (process.env.DATABASE_URL && BIN && portA) await dropDatabase(DB).catch(() => {});
  portA = 0;
});

test.beforeEach(async ({ page }, info) => {
  info.skip(!process.env.DATABASE_URL || !BIN, '未配置本地 PostgREST（DATABASE_URL / POSTGREST_BIN）');
  info.skip(
    info.project.name !== 'chromium-desktop',
    '故障注入只在 chromium-desktop 跑一次（服务端行为与视口无关）',
  );
  mode = 'pass';
  await forwardRest(page, `http://127.0.0.1:${proxyPort}`);
  const session = {
    access_token: admin.token,
    refresh_token: `refresh-${admin.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    user: {
      id: admin.id,
      email: admin.email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: { name: admin.name },
    },
  };
  await page.addInitScript((s) => localStorage.setItem('az-session-v68', s), JSON.stringify(session));
});

const pathOf = (m: (typeof MODULES)[number]) =>
  m.id === 'content' ? `${m.path}?q=${encodeURIComponent(threadTitle)}` : m.path;

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}-1440.png`, fullPage: false });
}

async function expectHealthy(page: Page, m: (typeof MODULES)[number]) {
  await expect(page.locator(m.ready).first()).toBeVisible();
  await expect(page.locator('[data-table-error]')).toHaveCount(0);
  if (m.id === 'content') await expect(page.locator('tbody[data-rows]')).toContainText(threadTitle);
}

/** 恢复后逐个点错误条上的按钮（概览可能不止一块），直到没有错误 */
async function retryAll(page: Page, label: RegExp) {
  for (let i = 0; i < 6; i++) {
    const errs = page.locator('[data-table-error]');
    if (!(await errs.count())) return;
    await errs.first().getByRole('button', { name: label }).click();
    await page.waitForLoadState('networkidle');
  }
}

async function expectKind(page: Page, kind: string, text: RegExp, within = 15_000) {
  const err = page.locator('[data-table-error]').first();
  await expect(err).toBeVisible({ timeout: within });
  await expect(err).toHaveAttribute('data-error-kind', kind);
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(text);
  await expect(err).not.toContainText('网络或服务暂时不可用');
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** 把基线里记下的真实请求原样发给 PostgREST B（管理员身份） */
async function replay(c: Call) {
  const r = await fetch(`http://127.0.0.1:${portB}/${c.path}`, {
    method: c.method,
    headers: { Authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: c.body ?? undefined,
  });
  const text = await r.text();
  let code = '';
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? '';
  } catch {
    /* 非 JSON（正常数据）*/
  }
  return { status: r.status, code, text };
}

/**
 * 等 PostgREST B 完成「NOTIFY 之后」的结构重载，并确认模块的每个端点都处于期望状态。
 * 根因（docs/audits/evidence/ci/admin-faults-flake-2026-10-28.md）：旧版只拿第一个端点、空请求体 `{}` 探测，
 * 而 mod_list_content 的 p_type 没有默认值——空体调用在健康状态下也是 404 PGRST202，
 * 所以「等 404」永远立即通过（没等重载），「等非 404」永远等不到；第一个端点是谁取决于基线里请求的先后（竞态）→ 偶发。
 * 现在：
 *   1. 重载信号 = 管理端口 /metrics 的 pgrst_schema_cache_loads_total{status="SUCCESS"} 超过 NOTIFY 前读数；
 *   2. 状态 = 重放基线里每个端点的真实请求：
 *      missing → 404 且 PGRST202（函数）/ PGRST205（表）——这两个码只来自结构缓存查找，DB 层的 42883 / 42P01 不算；
 *      present → 2xx（真实数据回来）。
 */
async function waitSchema(id: ModuleId, loadsBefore: number, want: 'missing' | 'present') {
  const cs = [...(calls.get(id) ?? new Map<string, Call>())];
  expect(cs.length, `${id}: 基线没有记录到真实请求`).toBeGreaterThan(0);
  let last = '';
  for (let i = 0; i < 100; i++) {
    const loads = await schemaCacheLoads(adminB).catch(() => loadsBefore);
    if (loads > loadsBefore) {
      const bad: string[] = [];
      for (const [ep, c] of cs) {
        const r = await replay(c).catch((e: Error) => ({ status: 0, code: '', text: e.message }));
        const ok =
          want === 'missing'
            ? r.status === 404 && r.code === (ep.startsWith('rpc/') ? 'PGRST202' : 'PGRST205')
            : r.status >= 200 && r.status < 300;
        if (!ok) bad.push(`${c.method} ${ep} → ${r.status} ${r.text.slice(0, 160)}`);
      }
      if (!bad.length) return;
      last = `已重载（加载计数 ${loadsBefore} → ${loads}），但 ${bad.join('；')}`;
    } else last = `结构缓存加载计数仍为 ${loads}（NOTIFY 前 ${loadsBefore}），重载未完成`;
    await sleep(100);
  }
  throw new Error(`PostgREST B 在 ${id} 上没有达到「${want}」状态：${last}`);
}

// ---------------------------------------------------------------- 0. 基线
test('基线：8 个模块在真实 PostgREST 上读出真实数据，并记录各自的数据端点', async ({ page }) => {
  test.setTimeout(90_000);
  for (const m of MODULES) {
    const seen = new Set<string>();
    const first = new Map<string, Call>();
    const on = (r: import('@playwright/test').Request) => {
      const u = new URL(r.url());
      const p = u.pathname.replace(/^\/rest\/v1\//, '');
      if (u.pathname.startsWith('/rest/v1/') && !/^profiles$/.test(p) && !/^site_content$/.test(p)) {
        seen.add(p);
        if (!first.has(p)) first.set(p, { method: r.method(), path: `${p}${u.search}`, body: r.postData() });
      }
    };
    page.on('request', on);
    await page.goto(pathOf(m));
    await expectHealthy(page, m);
    await page.waitForLoadState('networkidle');
    page.off('request', on);
    expect(seen.size, `${m.id} 没有任何数据请求`).toBeGreaterThan(0);
    // A15 清单核对：模块实际请求的数据端点 = 清单写的端点 + 后台外壳请求（清单写错或代码改了读取对象都会在这里失败）
    expect([...seen].sort(), `${m.id} 的数据端点与 admin-modules.ts 不一致`).toEqual(
      [...new Set([...m.endpoints, ...SHELL_ENDPOINTS])].sort(),
    );
    endpoints.set(m.id, seen);
    calls.set(m.id, first);
  }
  console.log(
    '[faults] endpoints',
    JSON.stringify(Object.fromEntries([...endpoints].map(([k, v]) => [k, [...v]]))),
  );
});

// ---------------------------------------------------------------- 1. 停进程
test('故障 1：停掉 PostgREST 进程 → 8 个模块都显示「无法连接数据服务」；同端口重启后「重试」恢复', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  for (const m of MODULES) {
    pgB!.kill('SIGTERM');
    await new Promise<void>((r) => (pgB!.exitCode !== null ? r() : pgB!.once('exit', () => r())));
    await page.goto(pathOf(m));
    await expectKind(page, 'network', /无法连接数据服务/);
    if (m.id === 'content') await shot(page, info, 'fault-content-network');
    pgB = await startPostgrest(DB, portB, { adminPort: adminB });
    await retryAll(page, /^重试$/);
    await expectHealthy(page, m);
  }
});

// ---------------------------------------------------------------- 2. 503
test('故障 2：本机代理回 503 → 8 个模块都显示「服务端出错（HTTP 503）」；代理恢复后「重试」恢复', async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const m of MODULES) {
    mode = '503';
    await page.goto(pathOf(m));
    await expectKind(page, 'server', /服务端出错（HTTP 503）/);
    mode = 'pass';
    await retryAll(page, /^重试$/);
    await expectHealthy(page, m);
  }
});

// ---------------------------------------------------------------- 3. 删函数 / 表
type Obj = { kind: 'function' | 'relation'; name: string };
const objectsOf = (id: ModuleId): Obj[] =>
  [...(endpoints.get(id) ?? [])].map((p) =>
    p.startsWith('rpc/') ? { kind: 'function', name: p.slice(4) } : { kind: 'relation', name: p },
  );

async function renameAll(objs: Obj[], from: (n: string) => string, to: (n: string) => string) {
  for (const o of objs) {
    if (o.kind === 'function')
      await db().query(
        `do $$ declare r regprocedure; begin
           for r in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = '${from(o.name)}' loop
             execute format('alter function %s rename to %I', r, '${to(o.name)}');
           end loop; end $$;`,
      );
    else await db().query(`alter table if exists public.${from(o.name)} rename to ${to(o.name)}`);
  }
  await db().query(`notify pgrst, 'reload schema'`);
}

test('故障 3：删除模块用到的函数 / 表（重命名 + 重载结构）→ PostgREST 真实回 404 PGRST202 / PGRST205 → 「数据库未就绪」；还原后「重新检测」恢复', async ({
  page,
}) => {
  test.setTimeout(180_000);
  expect(endpoints.size).toBe(MODULES.length);
  for (const m of MODULES) {
    const objs = objectsOf(m.id);
    const before = await schemaCacheLoads(adminB);
    await renameAll(
      objs,
      (n) => n,
      (n) => `${n}__fault`,
    );
    await waitSchema(m.id, before, 'missing');
    // 响应体是异步读的：先收集 Promise，错误条出现后等网络静止、再等全部读完才断言
    // （否则「错误条已出现、RPC 的 404 还没读完」时会漏记 PGRST202——2026-10-28 并行压测见过一次）
    const pending: Promise<{ ep: string; code: string }>[] = [];
    const on = (r: import('@playwright/test').Response) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/rest/v1/') && r.status() === 404)
        pending.push(
          r
            .json()
            .catch(() => ({}))
            .then((b) => ({
              ep: u.pathname.replace(/^\/rest\/v1\//, ''),
              code: (b as { code?: string }).code ?? '',
            })),
        );
    };
    page.on('response', on);
    await page.goto(pathOf(m));
    await expectKind(page, 'schema', /数据库未就绪/);
    await page.waitForLoadState('networkidle');
    page.off('response', on);
    const seen = await Promise.all(pending);
    const codes = seen.map((x) => x.code);
    expect(codes.length, `${m.id}: 没有看到 404`).toBeGreaterThan(0);
    // 每个 404 都必须来自结构缓存，且与端点类型对应：函数 → PGRST202，表 / 视图 → PGRST205
    for (const x of seen)
      expect(x.code, `${m.id}: ${x.ep}`).toBe(x.ep.startsWith('rpc/') ? 'PGRST202' : 'PGRST205');
    if (objs.some((o) => o.kind === 'function')) expect(codes, `${m.id}`).toContain('PGRST202');
    const beforeRestore = await schemaCacheLoads(adminB);
    await renameAll(
      objs,
      (n) => `${n}__fault`,
      (n) => n,
    );
    await waitSchema(m.id, beforeRestore, 'present');
    await retryAll(page, /^重新检测$/);
    await expectHealthy(page, m);
  }
});

// ---------------------------------------------------------------- 4. 撤销授权
type Grant = { sql: string };
async function revokeAll(objs: Obj[]): Promise<Grant[]> {
  const restore: Grant[] = [];
  for (const o of objs) {
    if (o.kind === 'function') {
      const { rows } = await db().query<{ sig: string; grantee: string }>(
        `select p.oid::regprocedure::text sig, case when a.grantee = 0 then 'public' else quote_ident(r.rolname) end grantee
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public' and p.proname = $1 and a.privilege_type = 'EXECUTE'
            and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))`,
        [o.name],
      );
      for (const x of rows) restore.push({ sql: `grant execute on function ${x.sig} to ${x.grantee}` });
      const sigs = await db().query<{ sig: string }>(
        `select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [o.name],
      );
      for (const s of sigs.rows)
        await db().query(`revoke execute on function ${s.sig} from public, anon, authenticated`);
    } else {
      const { rows } = await db().query<{ grantee: string; priv: string }>(
        `select case when a.grantee = 0 then 'public' else quote_ident(r.rolname) end grantee, a.privilege_type priv
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public' and c.relname = $1 and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))`,
        [o.name],
      );
      for (const x of rows) restore.push({ sql: `grant ${x.priv} on public.${o.name} to ${x.grantee}` });
      // 列级授权（如留言表只授权部分列）：REVOKE ALL 会连带撤销，必须单独记下来恢复
      const cols = await db().query<{ col: string; grantee: string; priv: string }>(
        `select quote_ident(at.attname) col, case when a.grantee = 0 then 'public' else quote_ident(r.rolname) end grantee,
                a.privilege_type priv
           from pg_attribute at join pg_class c on c.oid = at.attrelid join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(at.attacl) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'public' and c.relname = $1 and at.attacl is not null and not at.attisdropped
            and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))`,
        [o.name],
      );
      for (const x of cols.rows)
        restore.push({ sql: `grant ${x.priv} (${x.col}) on public.${o.name} to ${x.grantee}` });
      await db().query(`revoke all on public.${o.name} from public, anon, authenticated`);
    }
  }
  return restore;
}

test('故障 4：撤销模块用到的函数 / 表授权 → PostgREST 真实回 403 42501 → 「没有权限」；按原 ACL 恢复后「重试」恢复', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  expect(endpoints.size).toBe(MODULES.length);
  for (const m of MODULES) {
    const restore = await revokeAll(objectsOf(m.id));
    const statuses: { status: number; code: string }[] = [];
    const on = async (r: import('@playwright/test').Response) => {
      if (/\/rest\/v1\//.test(r.url()) && r.status() >= 400)
        statuses.push({
          status: r.status(),
          code: ((await r.json().catch(() => ({}))) as { code?: string }).code ?? '',
        });
    };
    page.on('response', on);
    await page.goto(pathOf(m));
    await expectKind(page, 'permission', /没有权限/);
    page.off('response', on);
    expect(statuses.some((s) => s.code === '42501' && (s.status === 403 || s.status === 401))).toBe(true);
    if (m.id === 'content') await shot(page, info, 'fault-content-permission');
    for (const g of restore) await db().query(g.sql);
    await retryAll(page, /^重试$/);
    await expectHealthy(page, m);
  }
});

// ---------------------------------------------------------------- 5. 慢响应
test('故障 5：代理延迟 12s（前端超时 8s）→ 8 个模块都显示「请求超时」；恢复后「重试」恢复', async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  for (const m of MODULES) {
    mode = 'slow';
    await page.goto(pathOf(m));
    // 内容页先等「到点定时发布」tick（8s 超时）再读列表（再 8s）→ 最坏约 16s 才出错误条（已知，PR 里列为待优化）
    const t0 = Date.now();
    await expectKind(page, 'timeout', /请求超时/, 25_000);
    console.log(`[faults] timeout ${m.id}: 错误条出现用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    if (m.id === 'content') await shot(page, info, 'fault-content-timeout');
    mode = 'pass';
    await retryAll(page, /^重试$/);
    await expectHealthy(page, m);
  }
});
