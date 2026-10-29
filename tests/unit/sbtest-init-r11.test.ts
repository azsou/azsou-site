/**
 * azsou-test 初始化执行器——第十一轮（站长 2026-10-29 round 11，B：finishHandoff 异常路径）回归。
 *  1. N = 0 只表示「本次没有成功写入任何交接行」。只有本次请求记录证明没有发出任何 Auth Admin 建号 / 改密请求时，
 *     才能写「没有新建账号、没有改密」。建号响应丢失 → 必须写「可能已创建、状态未知、需人工核对」；
 *     账号已建但交接文件写入失败 → 错误，保留证据，写明哪些账号的密码未交接。
 *  2. 交接 / 清理错误（例如空交接文件删除失败）不能掩盖原执行结果：原结论、阶段、逐项结果、清点照常写进记录，
 *     收尾错误单独列出；原 UNKNOWN（exit 3）不能降成 1 或 0；原成功 + 必需收尾失败 → exit 4（不是「完全完成」）。
 *     收尾失败从不自动重试建号 / 改密 / 其他写操作。
 * CLI 用例走真实本机 CLI 路径：起子进程 `node scripts/sbtest/init-executor.mjs execute …`，env-token 模式只连本测试进程里的
 * 回环 HTTP 假服务器（就是共用的 fakeApi 合成状态），不连任何托管项目。文件系统故障用 tests/fixtures/sbtest/fs-fault.mjs 预加载注入。
 * 先在 55518c6 上跑（失败），再修。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import { fakeApi, fresh, type Call, type Hooks, type State, type User, SPAWN_TIMEOUT } from './sbtest-fake';

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF } = E;
/** 第十一轮新增：原执行成功、但必需的交接 / 清理收尾失败（用字面量，修复前的代码里没有这个常量） */
const EXIT_INCOMPLETE = 4;

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
/** 种子已提交、4 个账号都在、文件未上传（只差 F1）——续跑不会发任何 Auth Admin 写请求 */
const seedDoneFilesMissing = (): State => {
  const users = ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k));
  return fresh({
    azInit: true,
    ledger: [
      ...REAL.migrations.map((x: { name: string; sha256: string }) => ({
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
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r11-${p}-`));
const FAULT = path.resolve('tests/fixtures/sbtest/fs-fault.mjs');

/** 把共用的 fakeApi（fetch 形式）挂到回环 HTTP 上；drop(method, path) 为真时先照常处理（状态已改），再掐断连接 = 响应丢失 */
async function bridge(st: State, hooks: Hooks, drop: (method: string, p: string) => boolean) {
  const api = fakeApi(st, hooks);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
      );
      const isBinary = p.startsWith('/storage/v1/object/');
      const r = await api.fetchImpl(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: raw.length ? (isBinary ? new Uint8Array(raw) : raw.toString('utf8')) : undefined,
      } as RequestInit);
      if (drop(req.method ?? 'GET', p)) {
        req.socket.destroy();
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

/** 起真实 CLI 子进程（异步：假服务器在本进程的事件循环里） */
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
  return new Promise<{ code: number | null; out: string }>((ok, bad) => {
    const ch = spawn(process.execPath, [...node, 'scripts/sbtest/init-executor.mjs', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (d) => (out += d));
    ch.stderr.on('data', (d) => (out += d));
    ch.on('error', bad);
    ch.on('close', (code) => ok({ code, out }));
  });
}
const exec = (hf: string, rec: string, resume = false) => [
  'execute',
  '--execute',
  ...(resume ? ['--resume'] : []),
  '--confirm-ref',
  TEST_REF,
  '--mode',
  'env-token',
  '--handoff-file',
  hf,
  '--record',
  rec,
];
const NONE_CLAIM = /本次没有新建账号|没有发出任何 Auth Admin 建号/;

describe('第十一轮 handoffConclusion（纯逻辑）', () => {
  const ADMIN_POST = (status: number | string) => ({
    phase: 'U1',
    method: 'POST',
    path: '/auth/v1/admin/users',
    status,
    ms: 1,
  });
  it('请求记录里没有任何 Auth Admin 写请求 + 0 行 → 才写「没有建号 / 改密」，空文件核对后删除', () => {
    const f = path.join(tmp('none'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    const r = E.handoffConclusion(h, { trace: [{ method: 'GET', path: '/v1/projects/x', status: 200 }] });
    expect(r.errors).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/N = 0/);
    expect(r.notes.join('\n')).toMatch(NONE_CLAIM);
    expect(existsSync(f)).toBe(false);
  });
  it('没有执行证据（不知道发没发过请求）→ 不写「没有建号」，保留文件', () => {
    const f = path.join(tmp('noev'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    const r = E.handoffConclusion(h, undefined);
    expect(r.notes.join('\n')).not.toMatch(NONE_CLAIM);
    expect(r.notes.join('\n')).toMatch(/人工核对/);
    expect(existsSync(f)).toBe(true);
  });
  it('建号请求已发出、响应丢失（ERR / 5xx）→ N = 0 写「可能已创建、状态未知、需人工核对」，不删文件', () => {
    for (const status of ['ERR:TypeError', 504]) {
      const f = path.join(tmp('lost'), 'h', 'a.jsonl');
      const h = E.fileHandoff(f, { attemptId: 'a1' });
      const r = E.handoffConclusion(h, {
        trace: [ADMIN_POST(status)],
        results: [{ file: `user:${synth('admin').email}`, outcome: 'unknown', error: 'fetch failed' }],
      });
      const t = r.notes.join('\n');
      expect(t).not.toMatch(NONE_CLAIM);
      expect(t).toMatch(/可能已创建/);
      expect(t).toMatch(/状态未知/);
      expect(t).toMatch(/人工核对/);
      expect(t).toContain(synth('admin').email);
      expect(existsSync(f)).toBe(true);
    }
  });
  it('建号 200 但交接写入失败（N = 0）→ 错误：写明已创建、密码未交接的账号，保留文件', () => {
    const f = path.join(tmp('wf'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    const r = E.handoffConclusion(h, {
      trace: [ADMIN_POST(200)],
      results: [
        {
          file: `user:${synth('admin').email}`,
          outcome: 'created-handoff-write-failed',
          error: 'ENOSPC',
        },
      ],
    });
    expect(r.errors.join('\n')).toMatch(/已创建.*密码未交接/);
    expect(r.errors.join('\n')).toContain(synth('admin').email);
    expect(r.notes.join('\n')).not.toMatch(NONE_CLAIM);
    expect(existsSync(f)).toBe(true);
  });
  it('建号请求全部被 4xx 拒绝（响应证明未建）→ 可以写未建号；N = 0 空文件删除', () => {
    const f = path.join(tmp('rej'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    const r = E.handoffConclusion(h, {
      trace: [ADMIN_POST(422)],
      results: [{ file: `user:${synth('admin').email}`, outcome: 'HTTP 422' }],
    });
    expect(r.errors).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/HTTP 4xx|被拒/);
    expect(existsSync(f)).toBe(false);
  });
});

describe('第十一轮 真实本机 CLI（子进程 + 回环假服务器 + 合成数据）', () => {
  // 每个 CLI 用例 30s（SPAWN_TIMEOUT）：起一个 node 子进程，经 CLI main 读钉住的 19 个迁移（起 git 子进程），
  // 再走回环 HTTP 跑完整执行 / 续跑；单实例实测见 docs/audits/evidence/sbtest/round11-2026-10-29.md。纯逻辑用例保持默认 5s。
  it(
    '建号响应丢失（服务器已建号、连接被掐断）→ exit 3；N = 0 写「可能已创建、状态未知、需人工核对」；不重试建号',
    async () => {
      const st = fresh();
      const b = await bridge(
        st,
        { onReadOnly: statusOk },
        (m, p) => m === 'POST' && p === '/auth/v1/admin/users',
      );
      const dir = tmp('lost');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(posts(b.api.calls)).toHaveLength(1); // 不重试
        expect(st.users).toHaveLength(1); // 云端确实建了
        const record = readFileSync(rec, 'utf8');
        for (const t of [record, r.out]) {
          expect(t).not.toMatch(NONE_CLAIM);
          expect(t).toMatch(/可能已创建/);
          expect(t).toMatch(/人工核对/);
        }
        expect(record).toMatch(/不确定/);
        expect(existsSync(hf)).toBe(true); // 证据保留
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '账号已建后交接文件写入失败（注入 ENOSPC）→ exit 3；错误写明已创建、密码未交接；保留文件；不再建号 / 改密',
    async () => {
      const st = fresh();
      const b = await bridge(st, { onReadOnly: statusOk }, () => false);
      const dir = tmp('wf');
      const hf = path.join(dir, 'h', 'r11-wf.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec), b.base, { mode: 'write-enospc', name: 'r11-wf.jsonl' });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(posts(b.api.calls)).toHaveLength(1);
        expect(puts(b.api.calls)).toHaveLength(0);
        expect(st.users).toHaveLength(1);
        const record = readFileSync(rec, 'utf8');
        for (const t of [record, r.out]) {
          expect(t).not.toMatch(NONE_CLAIM);
          expect(t).toMatch(/已创建.*密码未交接/);
          expect(t).toContain(synth('admin').email);
          expect(t).toMatch(/ENOSPC/);
        }
        expect(existsSync(hf)).toBe(true);
        expect(statSync(hf).mode & 0o777).toBe(0o600);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '原执行成功 + 空交接文件删除失败（注入 EACCES）→ exit 4（不是 0 也不是 1）；记录保留原结论 / 阶段 / 结果，收尾错误单列；不重试写',
    async () => {
      const st = seedDoneFilesMissing();
      const b = await bridge(st, { onReadOnly: statusOk }, () => false);
      const dir = tmp('ul0');
      const hf = path.join(dir, 'h', 'r11-ul0.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec, true), b.base, { mode: 'unlink-eacces', name: 'r11-ul0.jsonl' });
        expect(r.code, r.out).toBe(EXIT_INCOMPLETE);
        expect(posts(b.api.calls)).toHaveLength(0);
        expect(puts(b.api.calls)).toHaveLength(0);
        const n = uploads(b.api.calls).length;
        expect(n).toBe(st.objects.length); // 每个文件只传一次，收尾失败不重传
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：成功（V1 全部通过）/);
        expect(record).toMatch(/阶段：V1/);
        expect(record).toMatch(/收尾错误/);
        expect(record).toMatch(/EACCES/);
        expect(record).toMatch(/退出码 4/);
        expect(r.out).toMatch(/EACCES/);
        expect(existsSync(hf)).toBe(true);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '原执行不确定（上传响应丢失，exit 3）+ 空交接文件删除失败 → 仍 exit 3；记录保留原结论 / 阶段 F1 / 清点，收尾错误单列',
    async () => {
      const st = seedDoneFilesMissing();
      let dropped = false;
      const b = await bridge(st, { onReadOnly: statusOk }, (m, p) => {
        if (dropped || m !== 'POST' || !p.startsWith('/storage/v1/object/ugc-images/')) return false;
        return (dropped = true);
      });
      const dir = tmp('ul3');
      const hf = path.join(dir, 'h', 'r11-ul3.jsonl');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(hf, rec, true), b.base, { mode: 'unlink-eacces', name: 'r11-ul3.jsonl' });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(uploads(b.api.calls)).toHaveLength(1); // 不重试
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：不确定/);
        expect(record).toMatch(/阶段：F1/);
        expect(record).toMatch(/清点（unknown）/);
        expect(record).toMatch(/收尾错误/);
        expect(record).toMatch(/EACCES/);
        expect(existsSync(hf)).toBe(true);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
