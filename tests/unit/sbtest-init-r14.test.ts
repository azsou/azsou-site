/**
 * azsou-test 初始化执行器——第十四轮（站长 2026-10-30 round 14，B：#5 执行器统一受控输出，有限补丁）回归。
 *  1. ro()、通用 401 分类、形状错误等以前把服务器内容拼进异常消息，再流进正常 Markdown 运行记录、stdout / stderr。
 *     现在执行器内部统一受控输出：正常记录与兜底回执用同一投影层，所有用户可见文本只由受控字段拼成（S`…` + F.* 校验器）。
 *  2. errorCode() 不再用正则从任意文本里抽 E[A-Z…]：只读真实 Error 对象的 err.code（undici 再看一层 cause.code），
 *     在 fs / 网络错误码允许清单内才返回，否则 other；合成的 ESECRETDEMO42 经形状错误路径也不能出现。
 *  3. 保留有用信息：阶段、run / attempt、文件或合成账号、HTTP / 传输状态、核对结论、清点。不输出原始正文、任意异常对象、
 *     凭据、请求头、完整 URL（只给路径模板 / 主机类别）。不靠「截断到 200 字」，也不清空日志。injected 模式里没有秘密值，
 *     所以安全不能依赖已知秘密替换——这里的扫描只找合成标记，并且所有合成值都**不**作为 secrets 传给执行器。
 *  4. 退出码、阶段、已知结论、未知状态不变（与 41474de 矩阵对照，见 docs/audits/evidence/sbtest/round14-2026-10-30.md）。
 * 纯逻辑用例（进程内假 fetch）按 vitest 默认 5s；CLI 用例起真实子进程 `node scripts/sbtest/init-executor.mjs …`，
 * env-token 模式只连本测试进程里的回环 HTTP 假服务器，各自 30s（SPAWN_TIMEOUT）。只用合成数据，不读任何真实交接文件，
 * 不连任何托管项目，不做托管故障注入。先在 41474de 上跑（失败），再修。
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
import {
  MANIFEST,
  fakeApi,
  fresh,
  mk,
  run,
  type Hooks,
  type State,
  type User,
  SPAWN_TIMEOUT,
} from './sbtest-fake';

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF } = E;
const REAL = JSON.parse(readFileSync('ops/sbtest/init-manifest.json', 'utf8'));

/** 合成标记：像错误码的值、服务器正文标记、合成秘密。任何一个出现在输出里都算泄露 */
const CODEISH = 'ESECRETDEMO42';
const BODY = 'BODYMARK-r14';
const SYN = 'SYNTH-r14-secret-value';
const SRV_BODY = `{"message":"${CODEISH} ${BODY}","password" : "${SYN}","hint":"token=${SYN}"}`;
const LEAK = new RegExp(
  `${CODEISH}|${BODY}|${SYN}|injected fault|fake-mgmt-token|fake-service-key|https?://`,
);
const leaks = (s: string) => (s.match(new RegExp(LEAK.source, 'g')) ?? []).sort();

const synth = (key: string) => SYNTHETIC_USERS.find((u: { key: string }) => u.key === key);
const adoptable = (key: string, runId = '20261030T010203-abcdef'): User => ({
  email: synth(key).email,
  id: crypto.randomUUID(),
  key,
  confirmed: true,
  name: synth(key).name,
  run: runId,
  providers: ['email'],
  password: `old-pw-${key}`,
});
const OLD_RUN = '20261030T010203-abcdef';
/** 种子已提交、4 个账号都在、文件未上传（只差 F1）；manifest = 进程内假清单（纯逻辑）或仓库真实清单（CLI） */
const seedDoneFilesMissing = (manifest: { migrations: { name: string; sha256: string }[] } = REAL) => {
  const users = ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k));
  return fresh({
    azInit: true,
    ledger: [
      ...manifest.migrations.map((x) => ({ run_id: OLD_RUN, file: x.name, sha256: x.sha256 })),
      { run_id: OLD_RUN, file: 'seed', sha256: E.expectedSeedSha(users, OLD_RUN) },
    ],
    users,
    seeded: true,
  });
};
const statusOk = (q: string) => (q.includes('json_agg(x) as rows') ? { rows: null } : undefined);
const ledgerAware =
  (st: State, extra: (q: string) => unknown = () => undefined) =>
  (q: string) => {
    const o = extra(q);
    if (o !== undefined) return o;
    if (q.includes(' as v')) {
      const m = q.match(/file = '([^']+)' and run_id = '([^']+)'/)!;
      return {
        v: { ledger: st.ledger.filter((r) => r.file === m[1] && r.run_id === m[2]).length, running: 0 },
      };
    }
    return statusOk(q);
  };
const reply = (status: number, body = '') => new Response(body, { status });
/** status 查询在 0006 之后返回形状无效、带合成「错误码」与正文标记的值 */
const badStatusAt = (step: string) => (q: string) =>
  q.includes('json_agg(x) as rows') && q.includes(`step <= '${step}'`)
    ? { rows: `${CODEISH} ${BODY}` }
    : undefined;
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r14-${p}-`));
const FAULT = path.resolve('tests/fixtures/sbtest/fs-fault.mjs');
const errWith = (code: string, msg = `${CODEISH} ${BODY} ${SYN}`) => Object.assign(new Error(msg), { code });

describe('第十四轮 纯逻辑：受控输出 / 错误码允许清单（合成数据，进程内）', () => {
  it('errorCode：只读真实 Error 的 err.code（允许清单内）/ undici cause.code；字符串、普通对象、清单外的码 → other；绝不回显 ESECRETDEMO42', () => {
    const ec = (v: unknown) => E.errorCode(v).code;
    expect(ec(errWith('ENOSPC'))).toBe('ENOSPC');
    expect(ec(errWith('EACCES'))).toBe('EACCES');
    expect(ec(errWith('ECONNRESET'))).toBe('ECONNRESET');
    expect(ec(errWith('EAI_AGAIN'))).toBe('EAI_AGAIN');
    expect(ec(errWith(CODEISH))).toBe('other');
    expect(ec(`${CODEISH} ENOSPC HTTP 503`)).toBe('other');
    expect(ec({ code: 'ENOSPC', message: 'x' })).toBe('other'); // 不是 Error 对象
    expect(ec(new Error(`ENOENT: ${CODEISH}`))).toBe('other'); // 消息里像码不算
    const undici = new TypeError('fetch failed', { cause: errWith('ECONNREFUSED') });
    expect(ec(undici)).toBe('ECONNREFUSED');
    expect(ec(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe('other');
    expect(ec(new TypeError('fetch failed', { cause: errWith(CODEISH) }))).toBe('other');
    expect(E.ERROR_CODES).not.toContain(CODEISH);
    for (const v of [errWith(CODEISH), `HTTP 503 ${CODEISH}`, { code: CODEISH }, 42, null])
      expect(JSON.stringify(E.errorCode(v))).not.toContain(CODEISH);
  });
  it('形状错误 / 401 分类 / C0 / 账号核对：消息只有字段名、类型、计数——服务器值（ESECRETDEMO42、正文标记）不进消息', async () => {
    const msgs: string[] = [];
    const grab = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        msgs.push(String((e as Error).message));
      }
    };
    grab(() => E.parseOneRow(`${CODEISH} ${BODY}`, 'k'));
    grab(() => E.parseOneRow([`${CODEISH}`], 'k'));
    grab(() => E.parseChecked([{ k: `${CODEISH} ${BODY}` }], 'k', () => false, 'status 查询'));
    msgs.push(E.classify401(`{"msg":"bad jwt ${CODEISH} ${BODY}"}`).label);
    msgs.push(...E.c0ShapeProblems({ server_version: CODEISH, public_relations: BODY, cron_schema: SYN }));
    msgs.push(...E.cronShapeProblems({ cron_extension: CODEISH, cron_schema: false, cron_jobs: BODY }));
    msgs.push(
      ...E.adoptionProblems(
        { email: synth('admin').email, run: CODEISH, confirmed: true, providers: [BODY], name: 'x', id: SYN },
        OLD_RUN,
      ),
    );
    // ro()：非 2xx 只给状态码，不带正文
    const st = fresh();
    const { c } = mk(st, { onReadOnly: () => reply(504, SRV_BODY) });
    await E.ro(c, 'select 1', 'x').catch((e: Error) => msgs.push(e.message));
    expect(msgs.length).toBeGreaterThanOrEqual(8);
    for (const m of msgs) expect(leaks(m), m).toEqual([]);
    expect(msgs.join('\n')).toMatch(/类型 string/);
    expect(msgs.join('\n')).toMatch(/read-only HTTP 504/);
    expect(E.classify401(`{"msg":"x ${CODEISH}"}`).kind).toBe('other');
    expect(E.classify401('No API key found in request').kind).toBe('no_api_key');
  });
  it('写之后的形状错误（status 查询值带 ESECRETDEMO42）→ exit 3 不变；结果 / 备注 / 回执都没有合成值，回执错误码 = uncertain_shape', async () => {
    const st = fresh();
    const { c } = mk(st, { onReadOnly: ledgerAware(st, badStatusAt('0006')) });
    const r = await run(c, { handoff: 'discard' });
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(r.stage).toBe('0006');
    const bad = r.results.at(-1);
    expect(bad.outcome).toBe('status-check-unknown');
    const notes = E.executeNotes(r).join('\n');
    const rc = JSON.stringify(
      E.fallbackReceipt({
        command: 'execute',
        exit: r.exit,
        result: r,
        trace: c.trace,
        recordError: errWith(CODEISH),
      }),
    );
    for (const s of [JSON.stringify(r.results), notes, rc]) expect(leaks(s)).toEqual([]);
    expect(notes).toMatch(
      /结果 0006_m\.sql status-check-unknown（结果不确定：status 查询 的值不确定（类型 string））/,
    );
    expect(notes).toMatch(/阶段：0006/);
    const o = JSON.parse(rc);
    expect(o.results.at(-1).error).toEqual({
      code: 'uncertain_shape',
      status_class: 'none',
      phase: '0006',
      endpoint: 'POST /v1/projects/{ref}/database/query',
    });
    expect(o.record_write_failure).toEqual({ error: 'other' });
    expect(o.inventory.items.ledger).toHaveLength(6);
  });
  it('写之后的意外异常（网络 / 任意 Error，code 带 ESECRETDEMO42 或允许清单码）→ exit 3 不变；备注只给「意外错误（码）」', async () => {
    for (const [code, want] of [
      [CODEISH, 'other'],
      ['ECONNRESET', 'ECONNRESET'],
    ]) {
      const st = seedDoneFilesMissing(MANIFEST);
      const { c } = mk(st, {
        onReadOnly: (q) =>
          q.includes("bucket_id = 'ugc-images'") ? Promise.reject(errWith(code)) : undefined,
      });
      const r = await run(c, { handoff: 'discard', resume: true, runId: OLD_RUN });
      expect([code, r.exit]).toEqual([code, EXIT.UNKNOWN]);
      expect(r.stage).toBe('F1');
      const notes = E.executeNotes(r).join('\n');
      expect(leaks(notes)).toEqual([]);
      expect(leaks(JSON.stringify(r))).toEqual([]);
      expect(notes).toContain(`意外错误：意外错误（${want}）`);
      expect(notes).toContain(`run_id ${OLD_RUN}`);
    }
  });
  it('通用 401（正文带合成值）：预检准入不接受、分类保留（other），原因 / 项目主机探测都不带正文', async () => {
    const st = fresh({
      adminList: { status: 401, body: {}, raw: `{"msg":"invalid JWT ${CODEISH} ${BODY} ${SYN}"}` },
    });
    const { c } = mk(st, { unauthorized: (u) => u.includes('/storage/v1/bucket') });
    const pre = await E.preflight(c);
    expect(pre.service.accepted).toBe(false);
    expect(pre.service.reason).toMatch(/HTTP 401 \[other\]/);
    expect(leaks(pre.service.reason)).toEqual([]);
    const pj = await E.probeProject(c);
    expect(leaks(JSON.stringify(pj))).toEqual([]);
    expect(Object.values(pj).join('\n')).toMatch(/HTTP 401 \[other\]/);
    // client 抛出的 Unauthorized：kind 保留，消息无正文 / 无完整 URL
    const { c: c2 } = mk(fresh(), { unauthorized: () => true });
    const e = await c2.getProject().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(E.Unauthorized);
    expect(e.kind).toBe('other');
    expect(leaks(e.message)).toEqual([]);
  });
  it('兜底回执 / 正常运行记录：不解析错误文本（"HTTP 503 ESECRETDEMO42" → other）；清单外 error_code → other；记录里身份 / C0 / 目标 / 路径 / 备注都只出受控值', () => {
    const rc = E.fallbackReceipt({
      command: 'execute',
      exit: 3,
      result: {
        runId: OLD_RUN,
        attemptId: '20261030T020304-123abc',
        stage: '0005',
        results: [
          { file: '0005_m.sql', outcome: 'unknown', error: `HTTP 503 ${CODEISH} ${SRV_BODY}` },
          { file: '0006_m.sql', outcome: 'unknown', error: 'x', error_code: CODEISH },
          {
            file: '0007_m.sql',
            outcome: 'unknown',
            error: 'x',
            error_code: 'http_status',
            http: { status: 503 },
          },
          { file: `user:${synth('user').email}`, outcome: 'unknown', error: 'x', http: { error: 'network' } },
          {
            file: `${CODEISH}.sql`,
            outcome: CODEISH,
            verify: `${BODY}`,
            verification: { conclusion: 'x', basis: SYN },
          },
        ],
        inventory: {
          status: 'unknown',
          error: `read-only HTTP 504 ${CODEISH}`,
          items: {
            ledger: [{ file: `0001_${CODEISH.toLowerCase()}.sql`, run_id: CODEISH, sha256: 'abc…' }],
            counts: { 'public.comments': 1, [CODEISH.toLowerCase()]: 2 },
            storage_objects: [{ name: `abcd…ef/${CODEISH}.png`, size: 1 }],
          },
        },
      },
      trace: [
        {
          phase: '0005',
          method: 'POST',
          path: `/v1/projects/${TEST_REF}/database/query`,
          status: 503,
          ms: 1,
        },
        { phase: 'F1', method: 'POST', path: `/x/${CODEISH}`, status: `ERR:${CODEISH}`, ms: 1 },
      ],
      recordError: `ENOSPC: ${CODEISH}`,
    });
    const s = JSON.stringify(rc);
    expect(leaks(s)).toEqual([]);
    expect(s).not.toContain(CODEISH.toLowerCase());
    expect(rc.results[0].error).toEqual({
      code: 'other',
      status_class: 'none',
      phase: '0005',
      endpoint: 'POST /v1/projects/{ref}/database/query',
    });
    expect(rc.results[1].error.code).toBe('other');
    expect(rc.results[2].error).toMatchObject({ code: 'http_status', status_class: '5xx' });
    expect(rc.results[3].error).toMatchObject({ code: 'network', phase: 'U1' });
    expect(rc.results[4]).toMatchObject({ outcome: 'other', verify: '[已隐藏]' });
    expect(rc.results[4].verification).toEqual({ conclusion: 'other', basis: '[已隐藏]' });
    expect(rc.inventory.error.code).toBe('other');
    expect(rc.inventory.items.counts).toEqual({ 'public.comments': 1 });
    expect(rc.unknown_writes).toEqual([
      { phase: '0005', method: 'POST', path: `/v1/projects/${TEST_REF}/database/query`, status: 503 },
      { phase: 'F1', method: 'POST', path: '[路径格式不符，已隐藏]', status: 'ERR:other' },
    ]);
    expect(rc.record_write_failure).toEqual({ error: 'other' });
    expect(rc.run_id).toBe(OLD_RUN);
    expect(
      E.fallbackReceipt({ command: 'execute', exit: 4, recordError: errWith('ENOSPC') }).record_write_failure,
    ).toEqual({
      error: 'ENOSPC',
    });
    // 正常运行记录：输入被污染（服务器给的身份 / C0 / 目标字段、请求记录、调用方随手拼的备注）也只出受控值
    const md = E.runRecordMarkdown({
      command: 'preflight',
      title: `azsou-test preflight ${CODEISH}`,
      when: new Date().toISOString(),
      mode: 'env-token',
      endpoints: { mgmtBase: `http://u:${SYN}@127.0.0.1:9`, projectBase: 'http://127.0.0.1:10' },
      pre: {
        target: { ref: TEST_REF, org: `${CODEISH}` },
        scope: { list_projects: 403, verdict: `${BODY}` },
        identity: {
          current_database: CODEISH,
          current_user: BODY,
          version: `PostgreSQL 17.6 ${CODEISH}`,
          server_addr: '10.1.2.3',
          server_port: 5432,
          in_recovery: false,
        },
        c0: { server_version: '17.6', public_relations: 0, extensions: ['plpgsql', CODEISH] },
        c0_problems: [`raw ${SYN}`],
        service: { accepted: false, endpoint: 'x', reason: `HTTP 401 ${SRV_BODY}` },
      },
      trace: [{ phase: 'PS', method: 'GET', path: `/auth/v1/admin/users?x=${SYN}`, status: 401, ms: 3 }],
      verdict: `拒绝 ${CODEISH}`,
      notes: [`note ${BODY}`],
    });
    expect(leaks(md)).toEqual([]);
    expect(md).toMatch(/\| version \| PostgreSQL 17\.6 \|/);
    expect(md).toMatch(/\| server_addr \| 10\.x\.x\.x \|/);
    expect(md).toMatch(/\| server_port \| 5432 \|/);
    expect(md).toMatch(/plpgsql（另有 1 个不在允许清单内，名称不记录）/);
    expect(md).toMatch(/\| 1 \| PS \| GET \| \[路径格式不符，已隐藏\] \| 401 \| 3 \|/);
    expect(md).toMatch(/Management API 本机回环地址/);
  });
  it('按构造：S`…` 插值只放行登记文本 / 整数 / 布尔；Refused 的原始字符串消息 → [已隐藏]；源码里没有直接用字符串 / 普通模板构造执行器异常', () => {
    expect(E.S`a ${'raw'} b ${3} ${true}`).toBe('a [已隐藏] b 3 true');
    expect(E.S`x ${E.S`y`}`).toBe('x y');
    expect(new E.Refused(`拒绝 ${CODEISH}`).message).toBe('[已隐藏]');
    expect(new E.Refused(E.S`拒绝`).message).toBe('拒绝');
    expect(new E.Uncertain(`${CODEISH}`).message).toBe('结果不确定：[已隐藏]');
    expect(E.controlled({ a: 'raw', [CODEISH]: 1, b: [E.S`ok`, 2], c: { d: new Error('x') } })).toEqual({
      a: '[已隐藏]',
      b: ['ok', 2],
      c: { d: '[已隐藏]' },
    });
    expect(E.F.file(`${CODEISH}.sql`)).not.toContain(CODEISH);
    expect(E.F.runId(CODEISH)).toBe('[已隐藏]');
    expect(E.F.host(`https://u:${SYN}@evil.example/x`)).not.toMatch(/evil|SYNTH/);
    const src = readFileSync('scripts/sbtest/init-executor.mjs', 'utf8');
    const direct = src.match(
      /new (Refused|Uncertain|NotAdmitted|Unauthorized|NoInjection|Redirected|HttpStatusError)\(\s*['"`]/g,
    );
    expect(direct).toBeNull();
    // 输出口只有 safeText / safeJSON / S`…`：没有把异常 .message 直接拼进模板或 console。
    // plan / manifest 两个子命令零网络、只打印本地钉住清单 / 计划，不在本轮受控输出范围内，扫描时去掉这两段
    const cut = (t: string, a: string, b: string) => t.slice(0, t.indexOf(a)) + t.slice(t.indexOf(b));
    const net = cut(
      cut(src, "if (cmd === 'manifest') {", "if (cmd === 'preflight') {"),
      "if (cmd === 'plan') {",
      "if (cmd === 'execute') {",
    );
    expect(net).not.toMatch(/\$\{[^}]*\.message[^}]*\}/);
    expect(net).not.toMatch(/console\.(log|error)\(\s*`/);
    expect(net).not.toMatch(/console\.(log|error)\(\s*JSON\.stringify/);
  });
});

// ---------------------------------------------------------------- 真实本机 CLI
type Override =
  undefined | { drop: true; apply: boolean } | { status: number; apply: boolean; body?: string };

async function bridge(
  st: State,
  override: (m: string, p: string, body: string) => Override,
  hooks: Hooks = {},
) {
  const api = fakeApi(st, { onReadOnly: ledgerAware(st), ...hooks });
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
        res.writeHead(o.status);
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
        res.writeHead(o.status);
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
const firstLine = (body: string) => {
  try {
    return String(JSON.parse(body).query).split('\n')[0];
  } catch {
    return '';
  }
};
const DBQ = (p: string) => p.endsWith('/database/query');
const readOr = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
/** stdout / stderr / 运行记录 / 回执 四处一起扫 */
const scanAll = (r: { stdout: string; stderr: string }, rec: string) => ({
  stdout: leaks(r.stdout),
  stderr: leaks(r.stderr),
  record: leaks(readOr(rec)),
  receipt: leaks(receiptOf(r.stderr)?.line ?? ''),
});
const CLEAN = { stdout: [], stderr: [], record: [], receipt: [] };

describe('第十四轮 真实本机 CLI（子进程 + 回环假服务器 + 合成数据）', () => {
  // 每个 CLI 用例 30s（SPAWN_TIMEOUT）：起 node 子进程，经 CLI main 读钉住的 19 个迁移（起 git 子进程），再走回环 HTTP。
  it(
    'preflight：准入探测回通用 401（正文带合成值）→ exit 2 不变；stdout / stderr / 记录都没有正文；记录保留阶段、HTTP 401 [other]、请求表',
    async () => {
      const st = fresh();
      const b = await bridge(st, (m, p) =>
        m === 'GET' && p === '/auth/v1/admin/users'
          ? { status: 401, apply: false, body: `{"msg":"invalid JWT ${CODEISH} ${BODY} ${SYN}"}` }
          : undefined,
      );
      const rec = path.join(tmp('pf401'), 'rec.md');
      try {
        const r = await cli(['preflight', '--mode', 'env-token', '--record', rec], b.base);
        expect(r.code, r.out).toBe(EXIT.REFUSED);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        const md = readFileSync(rec, 'utf8');
        expect(md).toMatch(/HTTP 401 \[other\]/);
        expect(md).toMatch(/\| \d+ \| PS \| GET \| \/auth\/v1\/admin\/users \| 401 \|/);
        expect(md).toMatch(/Management API 本机回环地址/);
        // 身份核对仍有用（preflight 投影后再进记录，结果不变）
        expect(md).toMatch(/\| server_addr \| 10\.x\.x\.x \|/);
        expect(md).toMatch(/\| version \| PostgreSQL 17\.6 \|/);
        expect(r.stdout).toMatch(/"accepted": false/);
        expect(r.stdout).toMatch(/"server_addr": "10\.x\.x\.x"/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    'preflight：身份查询形状错误（值是带 ESECRETDEMO42 的字符串）→ exit 2 不变；stderr / 记录只写「结果不确定 … 类型 string」',
    async () => {
      const st = fresh();
      const b = await bridge(st, () => undefined, {
        onReadOnly: (q) => (q.includes('as identity') ? { identity: `${CODEISH} ${BODY}` } : undefined),
      });
      const rec = path.join(tmp('pfshape'), 'rec.md');
      try {
        const r = await cli(['preflight', '--mode', 'env-token', '--record', rec], b.base);
        expect(r.code, r.out).toBe(EXIT.REFUSED);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        expect(r.stderr).toMatch(/结果不确定：identity 的值不确定（类型 string）/);
        expect(readFileSync(rec, 'utf8')).toMatch(
          /结论：拒绝：结果不确定：identity 的值不确定（类型 string）/,
        );
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '正常记录写成功：0005 回 503（正文带合成值）但已提交 + 0006 后 status 查询形状错误 → exit 3 不变；记录有阶段 / run_id / 文件 / HTTP 503 / 核对 / 清点，没有正文',
    async () => {
      const st = fresh();
      const b = await bridge(
        st,
        (m, p, body) =>
          m === 'POST' && DBQ(p) && firstLine(body).includes(':0005_')
            ? { status: 503, apply: true, body: SRV_BODY }
            : undefined,
        { onReadOnly: ledgerAware(st, badStatusAt('0006')) },
      );
      const dir = tmp('rec');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base);
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        const md = readFileSync(rec, 'utf8');
        expect(md).toMatch(/结论：不确定/);
        expect(md).toMatch(/- run_id \d{8}T\d{6}-[0-9a-f]{6}/);
        expect(md).toMatch(/- 阶段：0006/);
        expect(md).toMatch(/0005_\S+ committed（HTTP 503；核对：committed，账本 1 行/);
        expect(md).toMatch(
          /0006_\S+ status-check-unknown（结果不确定：status 查询 的值不确定（类型 string））/,
        );
        expect(md).toMatch(/清点（unknown）：\{"ledger":\[/);
        expect(md).toMatch(/\| POST \| \/v1\/projects\/ovvfwkmqlejcpatmfqcd\/database\/query \| 503 \|/);
        expect(md).toMatch(/- 退出码 3：/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '记录写入失败（错误码是清单外的 ESECRETDEMO42，消息带标记）→ 兜底回执；exit 3 不变；回执 record_write_failure = other，两层结果与 uncertain_shape 保留',
    async () => {
      const st = fresh();
      const b = await bridge(
        st,
        (m, p, body) =>
          m === 'POST' && DBQ(p) && firstLine(body).includes(':0005_')
            ? { status: 503, apply: true, body: SRV_BODY }
            : undefined,
        { onReadOnly: ledgerAware(st, badStatusAt('0006')) },
      );
      const dir = tmp('rcx');
      const rec = path.join(dir, 'r14-rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base, {
          mode: 'record-esecret',
          name: 'r14-rec.md',
        });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        const rc = receiptOf(r.stderr);
        expect(rc, r.out).toBeDefined();
        expect(rc!.obj.record_write_failure).toEqual({ error: 'other' });
        expect(r.stderr).toMatch(/运行记录写入失败（other）/);
        const m5 = rc!.obj.results.find((x: { file: string }) => /^0005_/.test(x.file));
        expect(m5).toMatchObject({ outcome: 'committed', http: { status: 503 } });
        expect(m5.verification.conclusion).toBe('committed');
        const m6 = rc!.obj.results.find((x: { outcome: string }) => x.outcome === 'status-check-unknown');
        expect(m6.error).toMatchObject({ code: 'uncertain_shape', phase: '0006' });
        expect(rc!.obj.phase).toBe('0006');
        expect(rc!.obj.run_id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}$/);
        expect(rc!.obj.inventory.items.ledger).toHaveLength(6);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '记录写入失败（ENOSPC，允许清单码）+ 种子断线且未提交 → exit 1 不变；stderr 只给 ENOSPC，不带异常消息；回执种子 http = network、核对 not-committed',
    async () => {
      const st = fresh();
      const b = await bridge(st, (m, p, body) =>
        m === 'POST' && DBQ(p) && firstLine(body).includes(':seed */')
          ? { drop: true, apply: false }
          : undefined,
      );
      const dir = tmp('rce');
      const rec = path.join(dir, 'r14-rec2.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'a.jsonl'), rec), b.base, {
          mode: 'record-enospc',
          name: 'r14-rec2.md',
        });
        expect(r.code, r.out).toBe(EXIT.FAILED);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        expect(r.stderr).toMatch(/运行记录写入失败（ENOSPC）/);
        const rc = receiptOf(r.stderr)!;
        expect(rc.obj.record_write_failure).toEqual({ error: 'ENOSPC' });
        const s = rc.obj.results.find((x: { file: string }) => x.file === 'seed');
        expect(s).toMatchObject({ outcome: 'not-committed', http: { error: 'network' } });
        expect(s.verification.conclusion).toBe('not-committed');
        expect(rc.obj.phase).toBe('S1');
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
  it(
    '交接文件写入 ENOSPC（账号已建）→ exit 3 不变；正常记录写成功；记录 / stdout / stderr 只有 ENOSPC 码与合成账号，没有异常消息',
    async () => {
      const st = fresh();
      const b = await bridge(st, () => undefined);
      const dir = tmp('hf');
      const rec = path.join(dir, 'rec.md');
      try {
        const r = await cli(exec(path.join(dir, 'h', 'r14-h.jsonl'), rec), b.base, {
          mode: 'write-enospc',
          name: 'r14-h.jsonl',
        });
        expect(r.code, r.out).toBe(EXIT.UNKNOWN);
        expect(scanAll(r, rec)).toEqual(CLEAN);
        for (const u of st.users) expect(r.out + readOr(rec)).not.toContain(String(u.password));
        const md = readFileSync(rec, 'utf8');
        expect(md).toMatch(
          new RegExp(
            `结果 user:${synth('admin').email.replace('.', '\\.')} created-handoff-write-failed（ENOSPC）`,
          ),
        );
        expect(md).toMatch(/- 阶段：U1/);
        expect(md).toMatch(/交接错误：1 个账号已创建/);
      } finally {
        await b.close();
      }
    },
    SPAWN_TIMEOUT,
  );
});
