/**
 * azsou-test 初始化执行器——第十二轮（站长 2026-10-29 round 12，B：#5 两项有限收口）回归。
 *  A. 执行状态与证据一致（createUsers / rotateAdopted 执行层）：建号 / 改密写请求**已发出**、结果无法确定
 *     （5xx、超时、响应丢失、发出后收到 3xx）→ UNKNOWN（exit 3），立即停止后续写，保留已确认 + 未知状态，
 *     不自动重试、不隐式改密。显式拒绝（4xx，含 401）、写之前的安全闸门拒绝、确定性失败保持各自语义，不把所有非 0 都映射成 3。
 *     3xx 永不跟随（跨主机 Location 指向的服务器收不到任何请求）。
 *  B. 审计运行记录写入失败：输出打码的结构化兜底回执（一行 JSON，白名单字段：run_id、attempt_id、phase、逐项结果、
 *     已确认写、未知写、清点、记录写入失败本身），绝不输出密码、令牌、请求头、完整原始响应、交接文件内容；
 *     原退出码 1 / 2 / 3 不被覆盖；原成功 + 必需记录失败 → exit 4。
 *     「任何写端点本次一律未调用」只限只读预检阶段；execute 记录按实际请求记录描述写端点调用。
 *     N = 成功写入交接文件的记录条数，不是云端建号 / 改密次数；可能部分写入的交接文件按敏感文件处理；不写「密码哪里都没有」。
 * 纯逻辑用例（进程内假 fetch，不起子进程）按 vitest 默认 5s；CLI 用例起真实子进程
 * `node scripts/sbtest/init-executor.mjs …`，env-token 模式只连本测试进程里的回环 HTTP 假服务器（共用 fakeApi 合成状态），
 * 文件系统故障用 tests/fixtures/sbtest/fs-fault.mjs 预加载注入，各自 30s（SPAWN_TIMEOUT）。不连任何托管项目。
 * 先在 af90b8a 上跑（失败），再修。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import {
  fakeApi,
  fresh,
  mk,
  run,
  MANIFEST,
  type Call,
  type State,
  type User,
  SPAWN_TIMEOUT,
} from './sbtest-fake';

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF } = E;

const REAL = JSON.parse(readFileSync('ops/sbtest/init-manifest.json', 'utf8'));
const synth = (key: string) => SYNTHETIC_USERS.find((u: { key: string }) => u.key === key);
const adoptable = (key: string, runId = 'old1'): User => ({
  email: synth(key).email,
  id: crypto.randomUUID(),
  key,
  confirmed: true,
  name: synth(key).name,
  run: runId,
  providers: ['email'],
  password: `old-pw-${key}`,
});
/** 种子已提交、4 个账号都在、文件未上传（只差 F1） */
const seedDoneFilesMissing = (ledgerManifest = REAL): State => {
  const users = ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k));
  return fresh({
    azInit: true,
    ledger: [
      ...ledgerManifest.migrations.map((x: { name: string; sha256: string }) => ({
        run_id: 'old1',
        file: x.name,
        sha256: x.sha256,
      })),
      { run_id: 'old1', file: 'seed', sha256: E.expectedSeedSha(users, 'old1') },
    ],
    users,
    seeded: true,
  });
};
const statusOk = (q: string) => (q.includes('json_agg(x) as rows') ? { rows: null } : undefined);
const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === '/auth/v1/admin/users');
const puts = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PUT' && c.url.includes('/auth/v1/admin/users/'));
const uploads = (calls: Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.url.includes('/storage/v1/object/ugc-images/'));
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r12-${p}-`));
const FAULT = path.resolve('tests/fixtures/sbtest/fs-fault.mjs');
const RECEIPT_KEYS = [
  'receipt',
  'command',
  'exit',
  'run_id',
  'attempt_id',
  'phase',
  'results',
  'confirmed_writes',
  'unknown_writes',
  'inventory',
  'record_write_failure',
].sort();
/** 兜底回执里绝不能出现的东西（请求头名、令牌、密码字样） */
const FORBIDDEN =
  /authorization|apikey|bearer|password|fake-mgmt-token|fake-service-key|tok-SECRET|svc-SECRET/i;

type Override =
  undefined | { drop: true } | { status: number; location?: string; apply: boolean; body?: string };

/** fakeApi 挂到回环 HTTP；override(method, path) 可以：先照常处理（状态已改）再掐断 / 改写状态码；或不处理直接回答 */
async function bridge(st: State, override: (method: string, p: string) => Override) {
  const api = fakeApi(st, { onReadOnly: statusOk });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const o = override(req.method ?? 'GET', p);
      if (o && 'status' in o && !o.apply) {
        api.calls.push({
          url: `http://127.0.0.1${req.url}`,
          method: req.method ?? 'GET',
          headers: {},
          body: '',
        });
        res.writeHead(o.status, o.location ? { location: o.location } : {});
        res.end(o.body ?? '');
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
      );
      const isBinary = p.startsWith('/storage/v1/object/');
      const r = await api.fetchImpl(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: raw.length ? (isBinary ? new Uint8Array(raw) : raw.toString('utf8')) : undefined,
      } as RequestInit);
      if (o && 'drop' in o) {
        req.socket.destroy();
        return;
      }
      if (o && 'status' in o) {
        // 服务器已经照常处理（账号已建 / 密码已改），回给客户端的却是 3xx / 5xx
        res.writeHead(o.status, o.location ? { location: o.location } : {});
        res.end(o.body ?? '');
        return;
      }
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      res.end(body);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, base, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** 重定向目标：另一个回环端口上的服务器，只数请求次数（证明 3xx 从不被跟随） */
async function sink() {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"00000000-0000-0000-0000-000000000000"}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits: () => hits, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** 起真实 CLI 子进程；stdout / stderr 分开收 */
function cli(args: string[], base: string, fault?: { mode: string; name: string }) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? os.tmpdir(),
    SBTEST_CRED_MODE: 'env-token',
    SBTEST_MGMT_TOKEN: 'fake-mgmt-token',
    SBTEST_SERVICE_KEY: 'fake-service-key',
    SBTEST_MGMT_BASE: base,
    SBTEST_PROJECT_BASE: base,
    SBTEST_OWNER_APPROVAL: 'synthetic-local-test',
    NO_PROXY: '127.0.0.1,localhost',
  };
  const node = fault ? ['--import', pathToFileURL(FAULT).href] : [];
  if (fault) Object.assign(env, { SBTEST_FS_FAULT: fault.mode, SBTEST_FS_FAULT_NAME: fault.name });
  return new Promise<{ code: number | null; out: string; stdout: string; stderr: string }>((ok, bad) => {
    const ch = spawn(process.execPath, [...node, 'scripts/sbtest/init-executor.mjs', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    ch.stdout.on('data', (d) => (stdout += d));
    ch.stderr.on('data', (d) => (stderr += d));
    ch.on('error', bad);
    ch.on('close', (code) => ok({ code, out: `${stdout}\n${stderr}`, stdout, stderr }));
  });
}
const exec = (hf: string, rec: string, extra: string[] = []) => [
  'execute',
  '--execute',
  ...extra,
  '--confirm-ref',
  TEST_REF,
  '--mode',
  'env-token',
  '--handoff-file',
  hf,
  '--record',
  rec,
];
/** 兜底回执 = stderr 里以 {"receipt":"sbtest-run-fallback/v1" 开头的那一行 */
const receiptOf = (stderr: string) => {
  const line = stderr.split('\n').find((l) => l.startsWith('{"receipt":"sbtest-run-fallback/v1"'));
  return line ? { line, obj: JSON.parse(line) } : undefined;
};

describe('第十二轮 A：写请求已发出、结果不确定 → exit 3（纯逻辑，进程内假 fetch）', () => {
  const adminPost = (url: string, init: RequestInit) =>
    (init.method ?? 'GET') === 'POST' && new URL(url).pathname === '/auth/v1/admin/users';
  it('createUsers：发出后 3xx / 5xx → UNKNOWN（exit 3），立即停止，不跟随、不重试；4xx（422 / 401）保持原语义', async () => {
    const cases: [number, number][] = [
      [302, EXIT.UNKNOWN],
      [307, EXIT.UNKNOWN],
      [500, EXIT.UNKNOWN],
      [503, EXIT.UNKNOWN],
      [422, EXIT.FAILED],
      [401, EXIT.REFUSED],
    ];
    for (const [status, want] of cases) {
      const st = fresh();
      const { api, c } = mk(st, {
        onReadOnly: statusOk,
        any: (url, init) =>
          adminPost(url, init)
            ? new Response(status === 401 ? '{"message":"Invalid API key"}' : '', {
                status,
                headers: status < 400 ? { location: 'http://127.0.0.1:11/elsewhere' } : {},
              })
            : undefined,
      });
      const r = await run(c, { handoff: 'discard' });
      expect([status, r.exit]).toEqual([status, want]);
      expect(posts(api.calls)).toHaveLength(1); // 不重试、不建下一个
      expect(api.calls.some((x) => x.url.includes('/elsewhere'))).toBe(false); // 不跟随
      expect(uploads(api.calls)).toHaveLength(0); // 停止后续写
      expect(api.calls.every((x) => x.redirect === 'manual')).toBe(true);
      const u = r.results.find((x: { file: string }) => x.file === `user:${synth('admin').email}`);
      if (want === EXIT.UNKNOWN) expect(u?.outcome).toBe('unknown');
    }
  });
  it('rotateAdopted（显式改密）：PUT 发出后 3xx / 5xx → UNKNOWN（exit 3），不再改下一个、不上传；403 → 失败（exit 1）', async () => {
    const em = [synth('admin').email, synth('user').email];
    for (const [status, want] of [
      [307, EXIT.UNKNOWN],
      [503, EXIT.UNKNOWN],
      [403, EXIT.FAILED],
    ] as [number, number][]) {
      const st = seedDoneFilesMissing(MANIFEST);
      const { api, c } = mk(st, {
        onReadOnly: statusOk,
        any: (url, init) =>
          init.method === 'PUT' && url.includes('/auth/v1/admin/users/')
            ? new Response('', { status, headers: status < 400 ? { location: '/x' } : {} })
            : undefined,
      });
      const f = path.join(tmp('rot'), 'h', 'a.jsonl');
      const h = E.fileHandoff(f, { attemptId: 'a1' });
      const r = await run(c, { resume: true, handoff: h, rotate: { accounts: em, confirm: em } });
      expect([status, r.exit]).toEqual([status, want]);
      expect(puts(api.calls)).toHaveLength(1);
      expect(uploads(api.calls)).toHaveLength(0);
      if (want === EXIT.UNKNOWN)
        expect(r.results.some((x: { outcome: string }) => x.outcome === 'password-unknown')).toBe(true);
    }
  });
});

describe('第十二轮 B：兜底回执、记录措辞（纯逻辑）', () => {
  it('fallbackReceipt：只含白名单字段；密码 / 令牌 / 请求头 / 原始响应 / 交接内容一律不出现；路径里的用户 id 打码', () => {
    const uid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    const r = E.fallbackReceipt({
      command: 'execute',
      exit: 3,
      result: {
        runId: 'run-1',
        attemptId: 'att-1',
        stage: 'U1',
        results: [
          { file: 'az_init', outcome: 'committed' },
          { file: `user:${synth('admin').email}`, outcome: 'created', password: 'p@ss-SECRET' },
          {
            file: `user:${synth('user').email}`,
            outcome: 'unknown',
            error: 'Bearer tok-SECRET fetch failed',
          },
        ],
        inventory: {
          status: 'unknown',
          items: { accounts: [{ email: synth('admin').email, id: 'abcd…ef' }] },
        },
        raw: '{"access_token":"tok-SECRET"}',
        headers: { authorization: 'Bearer tok-SECRET', apikey: 'svc-SECRET' },
      },
      trace: [
        { phase: 'B0', method: 'POST', path: '/v1/projects/x/database/query', status: 201, ms: 1 },
        { phase: 'U1', method: 'POST', path: '/auth/v1/admin/users', status: 200, ms: 1 },
        { phase: 'U1', method: 'PUT', path: `/auth/v1/admin/users/${uid}`, status: 302, ms: 1 },
        { phase: 'U1', method: 'POST', path: '/auth/v1/admin/users', status: 'ERR:timeout', ms: 1 },
        { phase: 'V1', method: 'POST', path: '/v1/projects/x/database/query/read-only', status: 201, ms: 1 },
      ],
      recordError: 'ENOSPC',
      handoffContent: '{"email":"a","password":"p@ss-SECRET"}',
    });
    expect(Object.keys(r).sort()).toEqual(RECEIPT_KEYS);
    const s = JSON.stringify(r);
    expect(s).not.toMatch(FORBIDDEN);
    expect(s).not.toContain('SECRET');
    expect(s).not.toContain(uid);
    expect(r.run_id).toBe('run-1');
    expect(r.attempt_id).toBe('att-1');
    expect(r.phase).toBe('U1');
    expect(r.exit).toBe(3);
    expect(r.confirmed_writes).toHaveLength(2); // 只读查询不算写
    expect(r.unknown_writes).toHaveLength(2); // 302 + ERR:timeout
    expect(r.record_write_failure.error).toBe('ENOSPC');
    expect(r.results.map((x: { outcome: string }) => x.outcome)).toEqual(['committed', 'created', 'unknown']);
  });
  it('运行记录：「写端点一律未调用」只限只读预检阶段；execute 记录按请求记录列出写端点调用', () => {
    const base = {
      title: 't',
      when: 'w',
      mode: 'env-token',
      pre: { scope: { list_projects: 403, verdict: 'v' } },
      verdict: '不确定',
    };
    const exe = E.runRecordMarkdown({
      ...base,
      command: 'execute',
      trace: [
        { phase: 'P0', method: 'GET', path: '/v1/projects/x', status: 200, ms: 1 },
        { phase: 'B0', method: 'POST', path: '/v1/projects/x/database/query', status: 201, ms: 1 },
        { phase: 'U1', method: 'POST', path: '/auth/v1/admin/users', status: 503, ms: 1 },
      ],
    });
    expect(exe).not.toMatch(/本次一律未调用/);
    expect(exe).toMatch(/只读预检阶段/);
    expect(exe).toMatch(/写端点调用（按本次请求记录）/);
    expect(exe).toMatch(/已确认 1/);
    expect(exe).toMatch(/结果未知 1/);
    const pf = E.runRecordMarkdown({
      ...base,
      command: 'preflight',
      trace: [{ phase: 'P0', method: 'GET', path: '/v1/projects/x', status: 200, ms: 1 }],
    });
    expect(pf).toMatch(/只读预检阶段/);
    expect(pf).toMatch(/写端点调用 0 次/);
  });
  it('交接措辞：N = 成功写入交接文件的记录条数（不是建号 / 改密次数）；写入失败的文件按敏感文件处理；不写「密码哪里都没有」', () => {
    const f = path.join(tmp('wd'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    h.write(synth('admin').email, 'pw-x', crypto.randomUUID(), { run_id: 'r', attempt_id: 'a1' });
    const ok = E.handoffConclusion(h, {
      trace: [{ method: 'POST', path: '/auth/v1/admin/users', status: 200 }],
      results: [{ file: `user:${synth('admin').email}`, outcome: 'created' }],
    });
    expect(ok.notes.join('\n')).toMatch(/N = 1 条 = 本次成功写入交接文件的记录条数/);
    expect(ok.notes.join('\n')).toMatch(/不是云端建号 \/ 改密次数/);
    const f2 = path.join(tmp('wf'), 'h', 'b.jsonl');
    const h2 = E.fileHandoff(f2, { attemptId: 'a1' });
    const bad = E.handoffConclusion(h2, {
      trace: [{ method: 'POST', path: '/auth/v1/admin/users', status: 200 }],
      results: [
        { file: `user:${synth('admin').email}`, outcome: 'created-handoff-write-failed', error: 'ENOSPC' },
      ],
    });
    const t = [...bad.notes, ...bad.errors].join('\n');
    expect(t).toMatch(/可能已部分写入/);
    expect(t).toMatch(/敏感文件/);
    expect(t).not.toMatch(/不在任何地方|哪里都没有|密码不在交接文件里/);
  });
});

describe('第十二轮 真实本机 CLI（子进程 + 回环假服务器 + 合成数据）', () => {
  // 每个 CLI 用例 30s（SPAWN_TIMEOUT）：起 node 子进程，经 CLI main 读钉住的 19 个迁移（起 git 子进程），再走回环 HTTP。
  it(
    '建号 POST 已发出、服务器建号后回 302（Location 指向另一个回环端口）→ exit 3；不跟随（目标 0 次请求）；不重试、不再写',
    async () => {
      const st = fresh();
      const other = await sink();
      const b = await bridge(st, (m, p) =>
        m === 'POST' && p === '/auth/v1/admin/users'
          ? { status: 302, location: `${other.base}/auth/v1/admin/users`, apply: true }
          : undefined,
      );
      const dir = tmp('3xx');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(other.hits()).toBe(0);
        expect(posts(b.api.calls)).toHaveLength(1);
        expect(uploads(b.api.calls)).toHaveLength(0);
        expect(st.users).toHaveLength(1);
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：不确定/);
        expect(record).toMatch(/可能已创建/);
        expect(record).toMatch(/302/);
        expect(existsSync(hf)).toBe(true);
      } finally {
        await b.close();
        await other.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '建号 POST 已发出、服务器建号后回 503 → exit 3（不是 1）；不重试；记录「可能已创建、需人工核对」',
    async () => {
      const st = fresh();
      const b = await bridge(st, (m, p) =>
        m === 'POST' && p === '/auth/v1/admin/users' ? { status: 503, apply: true } : undefined,
      );
      const dir = tmp('5xx');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(posts(b.api.calls)).toHaveLength(1);
        expect(st.users).toHaveLength(1);
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：不确定/);
        expect(record).toMatch(/可能已创建/);
        expect(record).toMatch(/人工核对/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '显式改密 PUT 已发出、服务器改密后回 307 → exit 3（不是 2）；不跟随；不改下一个、不上传',
    async () => {
      const st = seedDoneFilesMissing();
      const b = await bridge(st, (m, p) =>
        m === 'PUT' && p.startsWith('/auth/v1/admin/users/')
          ? { status: 307, location: '/elsewhere', apply: true }
          : undefined,
      );
      const em = `${synth('admin').email},${synth('user').email}`;
      const dir = tmp('rot');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(
          exec(hf, rec, ['--resume', '--rotate-passwords', em, '--confirm-rotate', em]),
          b.base,
        );
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(puts(b.api.calls)).toHaveLength(1);
        expect(b.api.calls.some((x) => x.url.includes('/elsewhere'))).toBe(false);
        expect(uploads(b.api.calls)).toHaveLength(0);
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：不确定/);
        expect(record).toMatch(/密码可能已被改/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '原执行成功 + 运行记录写入失败（注入 ENOSPC）→ exit 4；stderr 一行白名单兜底回执（已确认写 / 清点 / 失败原因），无任何秘密',
    async () => {
      const st = seedDoneFilesMissing();
      const b = await bridge(st, () => undefined);
      const dir = tmp('rf0');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'r12-rec0.md');
      try {
        const r = await cli(exec(hf, rec, ['--resume']), b.base, {
          mode: 'record-enospc',
          name: 'r12-rec0.md',
        });
        expect(r.code, r.out).toBe(4);
        expect(existsSync(rec)).toBe(false);
        expect(uploads(b.api.calls)).toHaveLength(st.objects.length); // 不重传
        const rc = receiptOf(r.stderr);
        expect(rc, r.out).toBeDefined();
        expect(Object.keys(rc!.obj).sort()).toEqual(RECEIPT_KEYS);
        expect(rc!.line).not.toMatch(FORBIDDEN);
        expect(rc!.obj.exit).toBe(4);
        expect(rc!.obj.phase).toBe('V1');
        expect(rc!.obj.record_write_failure.error).toMatch(/ENOSPC/);
        expect(rc!.obj.confirmed_writes.length).toBe(st.objects.length);
        expect(rc!.obj.unknown_writes).toEqual([]);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '原执行不确定（第 1 个账号已建并交接、第 2 个建号响应丢失）+ 记录写入失败 → 仍 exit 3；回执列已确认 / 未知写；不含交接文件里的密码',
    async () => {
      const st = fresh();
      let n = 0;
      const b = await bridge(st, (m, p) =>
        m === 'POST' && p === '/auth/v1/admin/users' && ++n === 2 ? { drop: true } : undefined,
      );
      const dir = tmp('rf3');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'r12-rec3.md');
      try {
        const r = await cli(exec(hf, rec), b.base, { mode: 'record-enospc', name: 'r12-rec3.md' });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(posts(b.api.calls)).toHaveLength(2);
        expect(st.users).toHaveLength(2);
        const rc = receiptOf(r.stderr);
        expect(rc, r.out).toBeDefined();
        expect(Object.keys(rc!.obj).sort()).toEqual(RECEIPT_KEYS);
        expect(rc!.obj.exit).toBe(EXIT.UNKNOWN);
        expect(rc!.obj.phase).toBe('U1');
        expect(rc!.line).not.toMatch(FORBIDDEN);
        for (const u of st.users) expect(r.out).not.toContain(String(u.password));
        expect(r.out).not.toContain(readFileSync(hf, 'utf8').trim() || 'x'.repeat(64));
        expect(rc!.obj.unknown_writes.map((w: { method: string }) => w.method)).toEqual(['POST']);
        expect(
          rc!.obj.confirmed_writes.some((w: { path: string }) => w.path === '/auth/v1/admin/users'),
        ).toBe(true);
        expect(rc!.obj.inventory.status).toBe('unknown');
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    'preflight 记录写入失败：预检通过 → exit 4（不是 1）；预检拒绝（C0 非空）→ 仍 exit 2；两者都有兜底回执、0 写',
    async () => {
      for (const [st, want] of [
        [fresh(), 4],
        [fresh({ azInit: true }), EXIT.REFUSED],
      ] as [State, number][]) {
        const b = await bridge(st, () => undefined);
        const dir = tmp('pf');
        const rec = path.join(dir, 'r12-pf.md');
        try {
          const r = await cli(['preflight', '--mode', 'env-token', '--record', rec], b.base, {
            mode: 'record-enospc',
            name: 'r12-pf.md',
          });
          expect(r.code, r.out).toBe(want);
          const rc = receiptOf(r.stderr);
          expect(rc, r.out).toBeDefined();
          expect(rc!.line).not.toMatch(FORBIDDEN);
          expect(rc!.obj.command).toBe('preflight');
          expect(rc!.obj.confirmed_writes).toEqual([]);
          expect(rc!.obj.unknown_writes).toEqual([]);
        } finally {
          await b.close();
        }
      }
    },
    SPAWN_TIMEOUT,
  );
});
