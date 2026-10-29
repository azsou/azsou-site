/**
 * azsou-test 初始化执行器——第十三轮（站长 2026-10-30 round 13，B：#5 两项有限补丁）回归。
 *  A. 兜底回执真正的分层白名单：inventory 等嵌套结构逐层按允许的字段名 + 类型投影，未知字段直接丢弃（不转储）；
 *     错误 / 核对只输出受控错误码、阶段、端点、状态类别，不输出服务器原始正文；已知秘密值在**截断之前**替换（秘密跨截断点
 *     也不泄露前缀）；关键字规则同时覆盖 `password: value`、`"password" : "x"` 等写法，但不只靠关键字。
 *     只用**合成**秘密（SYNTH-…），从不读取 / 输出真实凭据。阶段、逐项结果、清点仍然有用（不被清空）。
 *  B. 其余写通道的不确定性（只动 B0、Storage 上传、迁移 / 种子及其回执）：
 *     - B0：发出后 5xx / 3xx / 断线，又没有可靠核对 → 不是「确定未提交」（exit 3）；核对到账本表已存在 → 已提交、继续。
 *     - Storage：发出后结果不确定 → 停止后续写、UNKNOWN（exit 3）；不自动重传 / 覆盖 / 删除。
 *     - 迁移 / 种子：沿用账本 + 运行标记核对（只读端点、从不访问 Location 主机）——已提交 / 确认未提交 / 仍在运行或无法核对分别处理，
 *       不把 5xx 一律映射成 3。
 *     - 写请求发出后的 3xx 永不跟随，也不当成「写之前的拒绝」。
 *     - 回执两层：① 原始 HTTP / 传输状态；② 账本 / 资源核对结论 + 依据（例如 HTTP 503 + 账本已提交 → 两者都保留，业务结果 = 已提交）。
 * 纯逻辑用例（进程内假 fetch，不起子进程）按 vitest 默认 5s；CLI 用例起真实子进程
 * `node scripts/sbtest/init-executor.mjs …`，env-token 模式只连本测试进程里的回环 HTTP 假服务器（共用 fakeApi 合成状态），
 * 各自 30s（SPAWN_TIMEOUT）。不连任何托管项目，不做托管故障注入。先在 17c494c 上跑（失败），再修。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import { fakeApi, fresh, mk, run, type Call, type State, type User, SPAWN_TIMEOUT } from './sbtest-fake';

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
/** 提交核对（{ledger, running}）按假服务器的真实账本回答；running(file) 可以模拟仍在运行的标记会话 */
const ledgerAware =
  (st: State, running: (file: string) => number = () => 0) =>
  (q: string) => {
    if (q.includes(' as v')) {
      const m = q.match(/file = '([^']+)' and run_id = '([^']+)'/)!;
      return {
        v: {
          ledger: st.ledger.filter((r) => r.file === m[1] && r.run_id === m[2]).length,
          running: running(m[1]),
        },
      };
    }
    return statusOk(q);
  };
const LEDGER_INSERT =
  /insert into az_init\.applied \(run_id, file, sha256\) values \('([^']+)', '([^']+)', '([^']+)'\)/;
/** 服务器把这条写真正提交了（账本 / schema / 种子状态都改了） */
const applyQuery = (st: State, q: string) => {
  if (q.includes('create schema if not exists az_init')) st.azInit = true;
  const m = q.match(LEDGER_INSERT);
  if (m) {
    st.ledger.push({ run_id: m[1], file: m[2], sha256: m[3] });
    if (m[2] === 'seed') st.seeded = true;
  }
};
const queries = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/database/query'));
const uploads = (calls: Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.url.includes('/storage/v1/object/ugc-images/'));
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r13-${p}-`));
const FAULT = path.resolve('tests/fixtures/sbtest/fs-fault.mjs');
const isBootstrap = (q: string) => q.includes('create schema if not exists az_init');
const reply = (status: number, body = '') =>
  new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers: status >= 300 && status < 400 ? { location: 'http://127.0.0.1:11/elsewhere' } : {},
  });
/** 合成服务器正文：带合成秘密与原始错误文本，绝不能出现在回执 / 结果里 */
const SRV_BODY =
  '{"message":"db exploded SYNTH-srv-msg","password" : "SYNTH-body-pw","hint":"token=SYNTH-tok"}';

describe('第十三轮 A：兜底回执分层白名单 / 受控错误 / 先打码后截断（纯逻辑，合成秘密）', () => {
  it('inventory 逐层投影：未知字段（任意层）丢弃不转储；已知字段保留且仍有用；非合成邮箱、未打码 id 不原样输出', () => {
    const uid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    const r = E.fallbackReceipt({
      command: 'execute',
      exit: 3,
      result: {
        runId: 'run-1',
        attemptId: '20261030T010203-abc123',
        stage: 'F1',
        results: [{ file: '0005_m.sql', outcome: 'committed' }],
        inventory: {
          status: 'unknown',
          raw_response: 'SYNTH-raw-response',
          items: {
            ledger: [
              { file: '0001_m.sql', run_id: 'run-1', sha256: 'abcdef012345…', body: 'SYNTH-ledger-body' },
              { file: 'seed', run_id: 'run-1', sha256: 'n/a…', extra: { token: 'SYNTH-ledger-nested' } },
            ],
            accounts: [
              {
                email: synth('admin').email,
                id: 'abcd…ef',
                password: 'SYNTH-acc-pw',
                raw: { token: 'SYNTH-acc-nested' },
              },
              { email: 'real.person@gmail.com', id: uid },
            ],
            counts: {
              'public.forum_threads': 2,
              'public.weird': 'SYNTH-count-str',
              evil: { x: 'SYNTH-evil' },
            },
            storage_objects: [{ name: 'abcd…ef/202610-sbtest-a-1x1.png', size: 70, owner: 'SYNTH-owner' }],
            running_sessions: 0,
            extra_item: { secret: 'SYNTH-extra' },
            debug: 'SYNTH-debug',
          },
        },
      },
      trace: [],
      recordError: 'ENOSPC',
    });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/SYNTH/);
    expect(s).not.toContain('real.person');
    expect(s).not.toContain(uid);
    const it = r.inventory.items;
    expect(Object.keys(it).sort()).toEqual(
      ['accounts', 'counts', 'ledger', 'running_sessions', 'storage_objects'].sort(),
    );
    expect(it.ledger).toEqual([
      { file: '0001_m.sql', run_id: 'run-1', sha256: 'abcdef012345…' },
      { file: 'seed', run_id: 'run-1', sha256: 'n/a…' },
    ]);
    expect(it.accounts[0]).toEqual({ email: synth('admin').email, id: 'abcd…ef' });
    expect(Object.keys(it.accounts[1]).sort()).toEqual(['email', 'id']);
    expect(it.counts).toEqual({ 'public.forum_threads': 2 });
    expect(it.storage_objects).toEqual([{ name: 'abcd…ef/202610-sbtest-a-1x1.png', size: 70 }]);
    expect(it.running_sessions).toBe(0);
    expect(r.inventory.status).toBe('unknown');
    expect(Object.keys(r.inventory).sort()).toEqual(['items', 'status']);
    // 仍然有用：阶段、逐项结果、run / attempt id 都在
    expect(r.phase).toBe('F1');
    expect(r.run_id).toBe('run-1');
    expect(r.results).toEqual([{ file: '0005_m.sql', outcome: 'committed' }]);
  });
  it('错误 / 核对 → 受控错误码 + 阶段 + 端点 + 状态类别；服务器原始正文、路径、合成秘密都不出现', () => {
    const r = E.fallbackReceipt({
      command: 'execute',
      exit: 3,
      result: {
        runId: 'r1',
        attemptId: 'a1',
        stage: 'F1',
        results: [
          { file: '0005_m.sql', outcome: 'unknown', error: `HTTP 503 ${SRV_BODY}` },
          {
            file: `user:${synth('admin').email}`,
            outcome: 'unknown',
            error: 'Auth Admin 建账号：HTTP 302 重定向被拒（不自动跟随；跨主机 a.example → b.example）',
          },
          { file: `user:${synth('user').email}`, outcome: 'password-unknown', error: 'other side closed' },
          { file: '202610-sbtest-a-1x1.png', outcome: 'unknown', error: 'fetch failed SYNTH-net' },
          { file: 'az_init', outcome: 'unknown', error: 'client-timeout' },
          { file: 'SYNTH-weird-file', outcome: 'SYNTH weird outcome', error: { nested: 'SYNTH-obj' } },
        ],
        inventory: { status: 'unknown', error: 'read-only HTTP 504 <html>SYNTH-gateway</html>' },
      },
      trace: [],
      recordError: "ENOSPC: no space left on device, open '/home/SYNTH-user/rec.md'",
    });
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/SYNTH|exploded|<html>|\/home\//);
    const errs = r.results.map((x: { error?: unknown }) => x.error);
    const DBQ = 'POST /v1/projects/{ref}/database/query';
    expect(errs[0]).toEqual({ code: 'http_status', status_class: '5xx', phase: '0005', endpoint: DBQ });
    expect(errs[1]).toEqual({
      code: 'redirect',
      status_class: '3xx',
      phase: 'U1',
      endpoint: 'POST /auth/v1/admin/users',
    });
    expect(errs[2]).toEqual({
      code: 'network',
      status_class: 'none',
      phase: 'U1',
      endpoint: 'PUT /auth/v1/admin/users/{id}',
    });
    expect(errs[3]).toEqual({
      code: 'network',
      status_class: 'none',
      phase: 'F1',
      endpoint: 'POST /storage/v1/object/ugc-images/{id}/{name}',
    });
    expect(errs[4]).toEqual({ code: 'timeout', status_class: 'none', phase: 'B0', endpoint: DBQ });
    expect(errs[5].code).toBe('other');
    expect(r.results[5].file).not.toMatch(/SYNTH/);
    expect(r.inventory.error).toEqual({
      code: 'http_status',
      status_class: '5xx',
      phase: 'INV',
      endpoint: 'POST /v1/projects/{ref}/database/query/read-only',
    });
    expect(r.record_write_failure).toEqual({ error: 'ENOSPC' });
  });
  it('redactText：已知秘密在截断前替换（跨截断点不泄露任何 ≥4 字符前缀）；password: v、"password" : "x"、token=…、带空格的引号值都打码', () => {
    expect(typeof E.redactText).toBe('function');
    const K = 'SYNTHknownSECRETvalue-0123456789';
    for (const pad of [180, 185, 190, 199, 200 - 4]) {
      const out = E.redactText('x'.repeat(pad) + K + ' tail', [K]);
      for (let n = 4; n <= K.length; n++)
        expect(out.includes(K.slice(0, n)), `pad ${pad} n ${n}`).toBe(false);
      expect(out.length).toBeLessThanOrEqual(201);
    }
    const kv: [string, string][] = [
      ['password: SYNTH-a1 rest', 'SYNTH-a1'],
      ['{"password" : "SYNTH-a2", "ok": 1}', 'SYNTH-a2'],
      ["{'secret': 'SYNTH a3 with spaces', 'n': 2}", 'SYNTH a3'],
      ['apikey=SYNTH-a4&x=1', 'SYNTH-a4'],
      ['Authorization:Bearer SYNTH-a5', 'SYNTH-a5'],
      ['token = SYNTH-a6', 'SYNTH-a6'],
      ['"access_token":"SYNTH-a7"', 'SYNTH-a7'],
      ['service_key\t:\t"SYNTH-a8"', 'SYNTH-a8'],
    ];
    for (const [input, secret] of kv) expect(E.redactText(input), input).not.toContain(secret);
    expect(E.redactText('{"password" : "SYNTH-a2", "ok": 1}')).toContain('"ok": 1');
    // 不只靠关键字：没有任何关键字的已知秘密值也被替换
    expect(E.redactText('leaked here: SYNTHnoKeywordValue99 end', ['SYNTHnoKeywordValue99'])).not.toContain(
      'SYNTHnoKeyword',
    );
    // 回执里的自由文本（核对依据 / 旧 verify 字段）同样先打码后截断
    const r = E.fallbackReceipt({
      command: 'execute',
      exit: 3,
      result: {
        runId: 'r1',
        attemptId: 'a1',
        stage: '0005',
        results: [
          { file: '0005_m.sql', outcome: 'unknown', verify: 'v'.repeat(190) + K },
          {
            file: '0006_m.sql',
            outcome: 'unknown',
            verification: { conclusion: 'unverifiable', basis: 'b'.repeat(150) + K, raw: 'SYNTH-raw' },
          },
        ],
      },
      trace: [],
      recordError: 'EACCES',
      secrets: [K],
    });
    const s = JSON.stringify(r);
    for (let n = 4; n <= K.length; n++) expect(s.includes(K.slice(0, n)), `receipt n ${n}`).toBe(false);
    expect(s).not.toContain('SYNTH-raw');
    expect(r.results[1].verification.conclusion).toBe('unverifiable');
  });
});

describe('第十三轮 B：B0 / 迁移 / 种子 / Storage 写请求发出后的不确定性（纯逻辑，进程内假 fetch）', () => {
  it('B0：发出后 5xx / 3xx / 断线——核对到账本表已存在 → 已提交、继续（exit 0）；不存在且无可靠核对 → exit 3（不是 1 / 2）；400 → 1；不跟随', async () => {
    const cases: [string, number | 'drop', boolean, number][] = [
      ['503 + 已提交', 503, true, EXIT.OK],
      ['503 + 未提交', 503, false, EXIT.UNKNOWN],
      ['307 + 已提交', 307, true, EXIT.OK],
      ['302 + 未提交', 302, false, EXIT.UNKNOWN],
      ['断线 + 未提交', 'drop', false, EXIT.UNKNOWN],
      ['断线 + 已提交', 'drop', true, EXIT.OK],
      ['400 显式拒绝', 400, false, EXIT.FAILED],
    ];
    for (const [label, status, apply, want] of cases) {
      const st = fresh();
      const { api, c } = mk(st, {
        onReadOnly: ledgerAware(st),
        onQuery: (q) => {
          if (!isBootstrap(q)) return undefined;
          if (apply) applyQuery(st, q);
          if (status === 'drop') throw new TypeError('fetch failed');
          return reply(status, SRV_BODY);
        },
      });
      const r = await run(c, { handoff: 'discard' });
      expect([label, r.exit]).toEqual([label, want]);
      expect(queries(api.calls).filter((x) => isBootstrap(JSON.parse(x.body).query))).toHaveLength(1);
      expect(api.calls.some((x) => x.url.includes('/elsewhere'))).toBe(false);
      const b0 = r.results.find((x: { file: string }) => x.file === 'az_init');
      expect(b0, label).toBeDefined();
      expect(JSON.stringify(r.results)).not.toMatch(/SYNTH|exploded/);
      if (want === EXIT.OK) {
        expect(b0.outcome).toBe('committed');
        expect(b0.verification.conclusion).toBe('committed');
      } else {
        // 不确定 / 失败：之后没有任何迁移写
        expect(queries(api.calls)).toHaveLength(1);
        expect(b0.outcome).toBe(want === EXIT.UNKNOWN ? 'unknown' : 'not-committed');
      }
      // 第 ① 层：原始 HTTP / 传输状态
      if (status === 'drop') expect(b0.http).toEqual({ error: 'network' });
      else expect(b0.http.status).toBe(status);
    }
  });
  it('迁移 / 种子：发出后 5xx / 3xx 按账本 + 运行标记核对——已提交 → 继续；确认未提交 → 1（不是一律 3）；仍在运行 / 核对失败（含核对请求 3xx）→ 3', async () => {
    type Case = [string, string, number, boolean, number, ((q: string) => unknown)?, string?];
    const cases: Case[] = [
      ['0005 503 + 已提交', '0005_m.sql', 503, true, EXIT.OK],
      ['0005 503 + 未提交', '0005_m.sql', 503, false, EXIT.FAILED],
      ['0005 307 + 已提交', '0005_m.sql', 307, true, EXIT.OK],
      ['0005 307 + 未提交', '0005_m.sql', 307, false, EXIT.FAILED],
      ['seed 502 + 已提交', 'seed', 502, true, EXIT.OK],
      ['seed 502 + 未提交', 'seed', 502, false, EXIT.FAILED],
      ['0005 504 + 仍在运行', '0005_m.sql', 504, false, EXIT.UNKNOWN, undefined, 'running'],
      [
        '0005 503 + 核对请求 307',
        '0005_m.sql',
        503,
        true,
        EXIT.UNKNOWN,
        (q) => (q.includes(' as v') ? reply(307) : statusOk(q)),
      ],
    ];
    for (const [label, file, status, apply, want, ro, flag] of cases) {
      const st = fresh();
      const target = file === 'seed' ? ':seed */' : `:${file} */`;
      const { api, c } = mk(st, {
        onReadOnly: ro ?? ledgerAware(st, (f) => (flag === 'running' && f === file ? 1 : 0)),
        onQuery: (q) => {
          if (!q.split('\n')[0].endsWith(target)) return undefined;
          if (apply) applyQuery(st, q);
          return reply(status, SRV_BODY);
        },
      });
      const r = await run(c, { handoff: 'discard' });
      expect([label, r.exit]).toEqual([label, want]);
      expect(api.calls.some((x) => x.url.includes('/elsewhere'))).toBe(false);
      const sent = queries(api.calls).filter((x) => JSON.parse(x.body).query.split('\n')[0].endsWith(target));
      expect(sent, label).toHaveLength(1); // 从不重试
      const res = r.results.find((x: { file: string }) => x.file === file);
      expect(res.http.status).toBe(status);
      expect(JSON.stringify(r.results)).not.toMatch(/SYNTH|exploded/);
      const concl =
        want === EXIT.OK
          ? 'committed'
          : want === EXIT.FAILED
            ? 'not-committed'
            : flag === 'running'
              ? 'still-running'
              : 'unverifiable';
      expect([label, res.verification.conclusion]).toEqual([label, concl]);
      expect(res.outcome).toBe(concl === 'unverifiable' ? 'unknown' : concl);
      if (want !== EXIT.OK) expect(uploads(api.calls)).toHaveLength(0);
    }
  });
  it('Storage 上传：发出后 5xx / 3xx / 断线 → UNKNOWN（exit 3），立即停止；不重传 / 不覆盖 / 不删除；4xx → 1；不跟随', async () => {
    const cases: [string, number | 'drop', boolean, number][] = [
      ['503 + 已存储', 503, true, EXIT.UNKNOWN],
      ['503 + 未存储', 503, false, EXIT.UNKNOWN],
      ['307 + 已存储', 307, true, EXIT.UNKNOWN],
      ['302 + 未存储', 302, false, EXIT.UNKNOWN],
      ['断线 + 已存储', 'drop', true, EXIT.UNKNOWN],
      ['409 显式拒绝', 409, false, EXIT.FAILED],
      ['413 显式拒绝', 413, false, EXIT.FAILED],
    ];
    for (const [label, status, apply, want] of cases) {
      const st = fresh();
      const { api, c } = mk(st, {
        onReadOnly: ledgerAware(st),
        any: (url, init) => {
          if (init.method !== 'POST' || !url.includes('/storage/v1/object/ugc-images/')) return undefined;
          if (apply)
            st.objects.push({
              name: decodeURIComponent(new URL(url).pathname.split('/ugc-images/')[1]),
              body: Buffer.from(init.body as Uint8Array),
            });
          if (status === 'drop') return Promise.reject(new TypeError('fetch failed')) as never;
          return reply(status, SRV_BODY);
        },
      });
      const r = await run(c, { handoff: 'discard' });
      expect([label, r.exit]).toEqual([label, want]);
      expect(uploads(api.calls)).toHaveLength(1); // 不重传、不传下一个
      expect(api.calls.some((x) => x.method === 'DELETE' || x.method === 'PUT')).toBe(false);
      expect(api.calls.some((x) => x.url.includes('/elsewhere'))).toBe(false);
      const f = r.results.find((x: { file: string }) => x.file === '202610-sbtest-a-1x1.png');
      expect(f.outcome).toBe(want === EXIT.UNKNOWN ? 'unknown' : `HTTP ${status}`);
      if (status === 'drop') expect(f.http).toEqual({ error: 'network' });
      else expect(f.http.status).toBe(status);
      expect(f.verification.conclusion).toBe(want === EXIT.UNKNOWN ? 'not-verified' : 'rejected');
      expect(JSON.stringify(r.results)).not.toMatch(/SYNTH|exploded/);
      expect(r.stage).toBe('F1');
    }
  });
  it('回执两层：HTTP 503 + 账本已提交 → http 503 与核对结论 committed 都保留、业务结果 = committed；后续 Storage 503 → unknown（未核对）', async () => {
    const st = fresh();
    const { c } = mk(st, {
      onReadOnly: ledgerAware(st),
      onQuery: (q) => {
        if (!q.split('\n')[0].endsWith(':0005_m.sql */')) return undefined;
        applyQuery(st, q);
        return reply(503, SRV_BODY);
      },
      onUpload: () => reply(503, SRV_BODY),
    });
    const r = await run(c, { handoff: 'discard' });
    expect(r.exit).toBe(EXIT.UNKNOWN);
    const rc = E.fallbackReceipt({
      command: 'execute',
      exit: r.exit,
      result: r,
      trace: c.trace,
      recordError: 'ENOSPC',
      secrets: ['tok-SECRET', 'svc-SECRET'],
    });
    const m = rc.results.find((x: { file: string }) => x.file === '0005_m.sql');
    expect(m.outcome).toBe('committed');
    expect(m.http).toEqual({ status: 503 });
    expect(m.verification.conclusion).toBe('committed');
    expect(m.verification.basis).toMatch(/账本/);
    const p = rc.results.find((x: { file: string }) => x.file === '202610-sbtest-a-1x1.png');
    expect(p.outcome).toBe('unknown');
    expect(p.http).toEqual({ status: 503 });
    expect(p.verification.conclusion).toBe('not-verified');
    expect(rc.phase).toBe('F1');
    const s = JSON.stringify(rc);
    expect(s).not.toMatch(/SYNTH|exploded|SECRET/);
    expect(rc.unknown_writes.map((w: { status: number }) => w.status)).toEqual([503, 503]);
    // 运行记录备注同样带两层
    const notes = E.executeNotes(r).join('\n');
    expect(notes).toMatch(/0005_m\.sql committed（HTTP 503；核对：committed/);
    expect(notes).not.toMatch(/SYNTH|exploded/);
  });
});

// ---------------------------------------------------------------- 真实本机 CLI
type Override =
  | undefined
  | { drop: true; apply: boolean }
  | { status: number; location?: string; apply: boolean; body?: string };

/** fakeApi 挂到回环 HTTP；override 决定这条请求服务器有没有真正处理（apply）以及回给客户端什么 */
async function bridge(st: State, override: (method: string, p: string, body: string) => Override) {
  const api = fakeApi(st, { onReadOnly: ledgerAware(st) });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const isBinary = p.startsWith('/storage/v1/object/');
      const o = override(req.method ?? 'GET', p, isBinary ? '' : raw.toString('utf8'));
      if (o && !o.apply) {
        api.calls.push({
          url: `http://127.0.0.1${req.url}`,
          method: req.method ?? 'GET',
          headers: {},
          body: '',
        });
        if ('drop' in o) return void req.socket.destroy();
        res.writeHead(o.status, o.location ? { location: o.location } : {});
        return void res.end(o.body ?? '');
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
      );
      const r = await api.fetchImpl(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers,
        body: raw.length ? (isBinary ? new Uint8Array(raw) : raw.toString('utf8')) : undefined,
      } as RequestInit);
      if (o && 'drop' in o) return void req.socket.destroy();
      if (o) {
        res.writeHead(o.status, o.location ? { location: o.location } : {});
        return void res.end(o.body ?? '');
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
    res.end('[]');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits: () => hits, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
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
const receiptOf = (stderr: string) => {
  const line = stderr.split('\n').find((l) => l.startsWith('{"receipt":"sbtest-run-fallback/v1"'));
  return line ? { line, obj: JSON.parse(line) } : undefined;
};
const FORBIDDEN = /authorization|apikey|bearer|fake-mgmt-token|fake-service-key|SYNTH|exploded/i;
const DBQ = (p: string) => p.endsWith('/database/query');
const firstLine = (body: string) => {
  try {
    return String(JSON.parse(body).query).split('\n')[0];
  } catch {
    return '';
  }
};

describe('第十三轮 真实本机 CLI（子进程 + 回环假服务器 + 合成数据）', () => {
  // 每个 CLI 用例 30s（SPAWN_TIMEOUT）：起 node 子进程，经 CLI main 读钉住的 19 个迁移（起 git 子进程），再走回环 HTTP。
  it(
    'B0：服务器已提交却回 503 → 核对账本表存在 → 继续并成功（exit 0，不是 1）；真的没提交却回 503 → exit 3（不是 1），之后 0 次迁移写',
    async () => {
      for (const [apply, want] of [
        [true, EXIT.OK],
        [false, EXIT.UNKNOWN],
      ] as [boolean, number][]) {
        const st = fresh();
        const b = await bridge(st, (m, p, body) =>
          m === 'POST' && DBQ(p) && isBootstrap(body) ? { status: 503, apply, body: SRV_BODY } : undefined,
        );
        const dir = tmp('b0');
        const rec = path.join(dir, 'rec.md');
        try {
          const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base);
          expect(r.code, r.out).toBe(want);
          const record = readFileSync(rec, 'utf8');
          expect(record).not.toMatch(/SYNTH|exploded/);
          if (apply) {
            expect(record).toMatch(/az_init committed（HTTP 503；核对：committed/);
            expect(st.ledger).toHaveLength(20);
          } else {
            expect(queries(b.api.calls)).toHaveLength(1);
            expect(record).toMatch(/结论：不确定/);
            expect(record).toMatch(/az_init unknown（HTTP 503；核对：unverifiable/);
          }
        } finally {
          await b.close();
        }
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '迁移 0007：服务器已提交却回 307（Location 指向另一回环端口）→ 不跟随（目标 0 次请求）、账本核对已提交、继续成功（exit 0，不是 2）；未提交却回 503 → exit 1',
    async () => {
      const other = await sink();
      try {
        for (const [status, apply, want] of [
          [307, true, EXIT.OK],
          [503, false, EXIT.FAILED],
        ] as [number, boolean, number][]) {
          const st = fresh();
          const b = await bridge(st, (m, p, body) =>
            m === 'POST' && DBQ(p) && firstLine(body).includes(':0007_')
              ? { status, apply, location: `${other.base}/v1/x`, body: SRV_BODY }
              : undefined,
          );
          const dir = tmp('mig');
          const rec = path.join(dir, 'rec.md');
          try {
            const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base);
            expect(r.code, r.out).toBe(want);
            const sent7 = queries(b.api.calls).filter((x) => firstLine(x.body).includes(':0007_'));
            expect(sent7.length).toBeLessThanOrEqual(1);
            const record = readFileSync(rec, 'utf8');
            expect(record).toMatch(
              apply
                ? /0007_\S+ committed（HTTP 307[^；]*；核对：committed/
                : /0007_\S+ not-committed（HTTP 503；核对：not-committed/,
            );
            expect(record).not.toMatch(/SYNTH|exploded/);
          } finally {
            await b.close();
          }
        }
        expect(other.hits()).toBe(0);
      } finally {
        await other.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    'Storage：服务器已存储却回 503 → exit 3（不是 1）；只 1 次上传、不重传 / 不删除；记录写「结果未知」与 HTTP 503',
    async () => {
      const st = seedDoneFilesMissing();
      const b = await bridge(st, (m, p) =>
        m === 'POST' && p.includes('/storage/v1/object/ugc-images/')
          ? { status: 503, apply: true, body: SRV_BODY }
          : undefined,
      );
      const dir = tmp('st5');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec, ['--resume']), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(uploads(b.api.calls)).toHaveLength(1);
        expect(st.objects).toHaveLength(1);
        expect(b.api.calls.some((x) => x.method === 'DELETE')).toBe(false);
        const record = readFileSync(rec, 'utf8');
        expect(record).toMatch(/结论：不确定/);
        expect(record).toMatch(/202610-sbtest-a-1x1\.png unknown（HTTP 503；核对：not-verified/);
        expect(record).not.toMatch(/SYNTH|exploded/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    'Storage：服务器未存储却回 302（Location 指向另一回环端口）→ exit 3（不是 2）；不跟随（目标 0 次请求）；只 1 次上传',
    async () => {
      const st = seedDoneFilesMissing();
      const other = await sink();
      const b = await bridge(st, (m, p) =>
        m === 'POST' && p.includes('/storage/v1/object/ugc-images/')
          ? { status: 302, apply: false, location: `${other.base}/storage/v1/object/x` }
          : undefined,
      );
      const dir = tmp('st3');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec, ['--resume']), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(other.hits()).toBe(0);
        expect(uploads(b.api.calls)).toHaveLength(1);
        expect(st.objects).toHaveLength(0);
        expect(readFileSync(rec, 'utf8')).toMatch(/202610-sbtest-a-1x1\.png unknown（HTTP 302/);
      } finally {
        await b.close();
        await other.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '种子：服务器已提交却回 502 → 账本核对已提交、继续（exit 0）；断线且未提交、标记会话已结束 → exit 1（确认未提交，不是 3）',
    async () => {
      for (const [o, want] of [
        [{ status: 502, apply: true, body: SRV_BODY }, EXIT.OK],
        [{ drop: true, apply: false }, EXIT.FAILED],
      ] as [Override, number][]) {
        const st = fresh();
        const b = await bridge(st, (m, p, body) =>
          m === 'POST' && DBQ(p) && firstLine(body).includes(':seed */') ? o : undefined,
        );
        const dir = tmp('seed');
        const rec = path.join(dir, 'rec.md');
        try {
          const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base);
          expect(r.code, r.out).toBe(want);
          const record = readFileSync(rec, 'utf8');
          expect(record).toMatch(
            want === EXIT.OK
              ? /seed committed（HTTP 502；核对：committed/
              : /seed not-committed（连接断开 \/ 无响应；核对：not-committed/,
          );
        } finally {
          await b.close();
        }
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '运行记录写入失败 + 迁移「503 但已提交」+ Storage 503 → exit 3；兜底回执两层（http 503 + 核对 committed / not-verified），无原始正文、无合成秘密',
    async () => {
      const st = fresh();
      const b = await bridge(st, (m, p, body) =>
        m === 'POST' && DBQ(p) && firstLine(body).includes(':0005_')
          ? { status: 503, apply: true, body: SRV_BODY }
          : m === 'POST' && p.includes('/storage/v1/object/ugc-images/')
            ? { status: 503, apply: false, body: SRV_BODY }
            : undefined,
      );
      const dir = tmp('rc');
      const rec = path.join(dir, 'r13-rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base, {
          mode: 'record-enospc',
          name: 'r13-rec.md',
        });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        const rc = receiptOf(r.stderr);
        expect(rc, r.out).toBeDefined();
        expect(rc!.line).not.toMatch(FORBIDDEN);
        for (const u of st.users) expect(r.out).not.toContain(String(u.password));
        const m5 = rc!.obj.results.find((x: { file: string }) => /^0005_/.test(x.file));
        expect(m5).toMatchObject({ outcome: 'committed', http: { status: 503 } });
        expect(m5.verification.conclusion).toBe('committed');
        const png = rc!.obj.results.find((x: { file: string }) => x.file === '202610-sbtest-a-1x1.png');
        expect(png).toMatchObject({ outcome: 'unknown', http: { status: 503 } });
        expect(png.verification.conclusion).toBe('not-verified');
        expect(rc!.obj.phase).toBe('F1');
        expect(rc!.obj.inventory.items.ledger.length).toBe(20);
        expect(rc!.obj.record_write_failure).toEqual({ error: 'ENOSPC' });
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
