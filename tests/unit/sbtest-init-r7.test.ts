/**
 * azsou-test 初始化执行器——第七轮（站长 2026-10-29）回归：先在当前代码上写失败用例，再修。
 *  ① 项目服务准入：第一次写之前必须用真正只读、需要 service_role 的 Auth Admin 列用户（GET /auth/v1/admin/users?per_page=1，
 *     形状 {users:[…]}）证明凭据被接受；Auth settings 成功 / Storage 空列表都不算；401/403/5xx/形状不符 → 不接受，拒绝。
 *  ② 不自动跟随重定向；任何 3xx（尤其跨主机）→ 拒绝。
 *  ③ 失败一律收紧：C0 {} / 缺键 / null / 版本无效 → 拒绝；超时核对 [{}] / 缺 ledger / running → unknown；
 *     迁移已提交后 status 查询网络错误 / JSON 错误 → 写出阶段、已知结果、打码清点、运行记录；
 *     seed 账本哈希格式对但值不对 → 拒绝（按实际期望的种子哈希比对）；种子事务带运行标记，超时核对同迁移。
 *  ④ 账号与续跑：不靠重置邮件 / 魔法链接；执行器生成强密码经 Auth Admin 设置，0600 文件交接（仓库外）；
 *     「部分账号已建」「4 个账号已建、种子未提交」→ 核对（邮箱 / 元数据 / 运行标记）后接管继续；文档与代码一致；
 *     影响清单分开列迁移自带行、账号相关行、种子新增行（合计 12）、资料更新；不再默认建议删除 / 重建 azsou-test。
 */
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import {
  FAKE_MG,
  FAKE_PJ,
  IMPACT,
  MANIFEST,
  SHA,
  fakeApi,
  fresh,
  mk,
  read,
  run,
  writes,
  type State,
} from './sbtest-fake';

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF, Refused } = E;

const ledgerUpTo = (n: number, runId = 'old1') =>
  MANIFEST.migrations
    .slice(0, n)
    .map((m: { name: string; sha256: string }) => ({ run_id: runId, file: m.name, sha256: m.sha256 }));
const synth = (key: string) => SYNTHETIC_USERS.find((u: { key: string }) => u.key === key);
const adoptable = (key: string, runId = 'old1') => ({
  email: synth(key).email,
  id: crypto.randomUUID(),
  key,
  confirmed: true,
  name: synth(key).name,
  run: runId,
  providers: ['email'],
});
const quiet = async <T>(fn: () => Promise<T>) => {
  const [l, e] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.error = e;
  }
};

// CLI 用例要从 git 对象库读钉住的迁移（机器忙时单个用例 > 5s；第八轮放宽，避免环境性超时）
vi.setConfig({ testTimeout: 30_000 });

describe('第七轮 ① 项目服务准入（第一次写之前）', () => {
  it('admitProjectService：200 且 {users:[…]} → 接受；只记数量', async () => {
    expect(typeof E.admitProjectService).toBe('function');
    const { api, c } = mk(fresh());
    const r = await E.admitProjectService(c);
    expect(r.accepted).toBe(true);
    expect(r.status).toBe(200);
    const call = api.calls.find((x) => x.url.includes('/auth/v1/admin/users'))!;
    expect(call.method).toBe('GET');
    expect(new URL(call.url).search).toBe('?per_page=1');
  });
  const bad: [string, State['adminList']][] = [
    ['401（apikey 没注入）', { status: 401, body: { message: 'No API key found in request' } }],
    ['403', { status: 403, body: { message: 'forbidden' } }],
    ['500', { status: 500, body: { message: 'boom' } }],
    ['503', { status: 503, body: {} }],
    ['200 但 {}', { status: 200, body: {} }],
    ['200 但 users 不是数组', { status: 200, body: { users: 'x' } }],
    ['200 但不是 JSON', { status: 200, body: null, raw: '<html>gateway</html>' }],
  ];
  for (const [label, adminList] of bad)
    it(`Auth Admin 列用户 ${label} → 不接受，execute 拒绝且一个写请求都不发`, async () => {
      // Auth settings 200 + Storage 空列表 200（旧版「注入探测」会认为通过）
      const { api, c } = mk(fresh({ adminList }));
      await expect(run(c)).rejects.toThrow(/不接受|not accepted/);
      expect(writes(api.calls)).toHaveLength(0);
      expect(api.calls.some((x) => x.url.includes('/auth/v1/admin/users') && x.method === 'GET')).toBe(true);
    });
  it('--resume 也先准入：401 → 拒绝，不发写请求', async () => {
    const { api, c } = mk(
      fresh({ azInit: true, ledger: ledgerUpTo(3), adminList: { status: 401, body: {} } }),
    );
    await expect(run(c, { resume: true })).rejects.toThrow(/不接受|not accepted/);
    expect(writes(api.calls)).toHaveLength(0);
  });
  it('preflight CLI：Auth Admin 401 → 退出码 2，运行记录写「不接受」', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r7-pre-'));
    const rec = path.join(dir, 'rec.md');
    const api = fakeApi(fresh({ adminList: { status: 401, body: {} } }));
    const code = await quiet(() => E.main(['preflight', '--record', rec], {}, api.fetchImpl));
    expect(code).toBe(EXIT.REFUSED);
    expect(readFileSync(rec, 'utf8')).toMatch(/不接受/);
    expect(readFileSync(rec, 'utf8')).toMatch(/\/auth\/v1\/admin\/users \| 401/);
  });
});

describe('第七轮 ② 不跟随重定向', () => {
  it('每个请求都以 redirect: manual 发出', async () => {
    const { api, c } = mk(fresh());
    await E.preflight(c);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(api.calls.every((x) => x.redirect === 'manual')).toBe(true);
  });
  it('跨主机重定向（→ api.supabase.com）→ 拒绝，不向目标主机发请求', async () => {
    const { api, c } = mk(fresh(), {
      any: (u) =>
        u.includes('/database/query/read-only')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://api.supabase.com/v1/projects/x/database/query/read-only' },
            })
          : undefined,
    });
    await expect(E.preflight(c)).rejects.toThrow(Refused);
    await expect(E.preflight(c)).rejects.toThrow(/重定向/);
    expect(api.calls.some((x) => x.url.includes('api.supabase.com'))).toBe(false);
  });
  it('同主机 307 也拒绝（不当成普通失败去核对账本）', async () => {
    const { api, c } = mk(fresh(), {
      onQuery: (q) =>
        q.includes('0002_m.sql')
          ? new Response(null, { status: 307, headers: { location: `${FAKE_MG}/elsewhere` } })
          : undefined,
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.REFUSED);
    expect(r.refused).toMatch(/重定向/);
    expect(api.calls.filter((x) => x.url.includes('0003'))).toHaveLength(0);
  });
});

describe('第七轮 ③ 失败收紧', () => {
  const good = (o: Record<string, unknown> = {}) => ({
    server_version: '17.6',
    public_relations: 0,
    public_functions: 0,
    private_schema: false,
    az_init_schema: false,
    supabase_migrations_schema: false,
    cron_extension: false,
    cron_schema: false,
    cron_jobs: 0,
    pg_net_extension: false,
    auth_users: 0,
    auth_identities: 0,
    auth_sessions: 0,
    auth_refresh_tokens: 0,
    storage_buckets: 0,
    storage_objects: 0,
    extensions: ['plpgsql'],
    ...o,
  });
  it('C0 完整且为空 → 无问题（对照）', () => {
    expect(E.preflightProblems(good())).toEqual([]);
  });
  it('C0 返回 {} / undefined → 拒绝（不是「空库」）', () => {
    expect(E.preflightProblems({}).length).toBeGreaterThan(0);
    expect(E.preflightProblems(undefined).length).toBeGreaterThan(0);
    expect(E.preflightProblems(null).length).toBeGreaterThan(0);
  });
  it('C0 缺键 / null / 类型不对 → 拒绝', () => {
    const missing: Record<string, unknown> = good();
    delete missing.auth_users;
    expect(E.preflightProblems(missing).join()).toMatch(/auth_users/);
    expect(E.preflightProblems(good({ storage_objects: null })).join()).toMatch(/storage_objects/);
    expect(E.preflightProblems(good({ cron_jobs: 'zero' })).join()).toMatch(/cron_jobs/);
    expect(E.preflightProblems(good({ private_schema: 'no' })).join()).toMatch(/private_schema/);
  });
  it('C0 版本无效 → 拒绝', () => {
    for (const v of ['abc', '', null, undefined, 'PostgreSQL'])
      expect(E.preflightProblems(good({ server_version: v })).join()).toMatch(/server_version|版本/);
  });
  it('execute：C0 为 {} → 拒绝，一个写请求都不发', async () => {
    const { api, c } = mk(fresh(), {
      onReadOnly: (q) => (q.includes('as preflight') ? { preflight: {} } : undefined),
    });
    await expect(run(c)).rejects.toThrow(Refused);
    expect(writes(api.calls)).toHaveLength(0);
  });
  it('preflight CLI：C0 为 {} → 退出码 2', async () => {
    const api = fakeApi(fresh(), {
      onReadOnly: (q) => (q.includes('as preflight') ? { preflight: {} } : undefined),
    });
    expect(await quiet(() => E.main(['preflight'], {}, api.fetchImpl))).toBe(EXIT.REFUSED);
  });

  const m = { name: '0005_m.sql', sha256: 'f'.repeat(64) };
  const sql = read('db/migrations/0005_m.sql');
  const timeoutWith = (verify: unknown) =>
    mk(fresh(), {
      onQuery: () => {
        throw new Error('client-timeout');
      },
      onReadOnly: (q) => (q.includes('as v') ? verify : undefined),
    }).c;
  for (const [label, v] of [
    ['[{}]', new Response('[{}]', { status: 201 })],
    ['[{v:{}}]', { v: {} }],
    ['缺 running', { v: { ledger: 0 } }],
    ['缺 ledger', { v: { running: 0 } }],
    ['ledger = null', { v: { ledger: null, running: 0 } }],
    ['ledger = 2', { v: { ledger: 2, running: 0 } }],
    ['[]', new Response('[]', { status: 201 })],
  ] as [string, unknown][])
    it(`超时后核对返回 ${label} → unknown（不是 not-committed）`, async () => {
      expect((await E.applyOne(timeoutWith(v), m, sql, 'r')).outcome).toBe('unknown');
    });

  for (const [label, resp] of [
    ['网络错误', () => Promise.reject(new TypeError('fetch failed'))],
    ['JSON 错误', () => new Response('not json', { status: 201 })],
  ] as [string, () => unknown][])
    it(`0005 已提交后 status 查询${label} → exit 3，写出阶段 / 已知结果 / 打码清点`, async () => {
      const st = fresh();
      const { c } = mk(st, {
        onReadOnly: (q) =>
          q.includes('as rows') && q.includes("step <= '0005'") ? (resp() as Response) : undefined,
      });
      const r = await run(c);
      expect(r.exit).toBe(EXIT.UNKNOWN);
      expect(r.stage).toBe('0005');
      expect(r.results.filter((x: { outcome: string }) => x.outcome === 'committed')).toHaveLength(5);
      expect(r.inventory).toBeDefined();
      expect(r.inventory.status).toBe('unknown');
      expect(r.inventory.items.ledger).toHaveLength(5);
    });

  it('CLI execute：写后出意外 → 运行记录里有阶段、已知结果与清点', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r7-ex-'));
    const rec = path.join(dir, 'rec.md');
    const st = fresh();
    let n = 0;
    const api = fakeApi(st, {
      // 真实 status.sql 文本会被通用假回答误配，这里显式回答 status 查询：第 1 次（0002）全 true，第 2 次（0003）网络错误
      onReadOnly: (q) => {
        if (!(q.includes('as rows') && q.includes('step <='))) return undefined;
        return ++n === 2
          ? (Promise.reject(new TypeError('fetch failed')) as unknown as Response)
          : { rows: null };
      },
    });
    const code = await quiet(() =>
      E.main(
        // 第八轮：真实目标（injected）不允许 discard → 改用仓库外交接文件
        [
          'execute',
          '--execute',
          '--confirm-ref',
          TEST_REF,
          '--handoff-file',
          path.join(dir, 'h', 'a.jsonl'),
          '--record',
          rec,
        ],
        { SBTEST_OWNER_APPROVAL: 'test' },
        api.fetchImpl,
      ),
    );
    expect(code).toBe(EXIT.UNKNOWN);
    const md = readFileSync(rec, 'utf8');
    expect(md).toMatch(/阶段[：:] ?0003/);
    expect(md).toMatch(/0001.*committed/);
    expect(md).toMatch(/清点/);
  });

  it('V1：seed 账本哈希格式对但不是本次种子的实际哈希 → V1.ledger 不通过', async () => {
    const st = fresh();
    const { c } = mk(st, {
      onQuery: (q) => {
        if (!q.includes("'seed'")) return undefined;
        st.ledger.push({ run_id: 'r1', file: 'seed', sha256: 'e'.repeat(64) });
        st.seeded = true;
        return Response.json([], { status: 201 });
      },
    });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.FAILED);
    const led = r.v1.checks.find((x: { id: string }) => x.id === 'V1.ledger');
    expect(led.ok).toBe(false);
    expect(JSON.stringify(led.detail)).toMatch(/seed/);
  });
  it('--resume：seed 已提交但账本哈希不是期望值 → 拒绝', async () => {
    const st = fresh();
    expect((await run(mk(st).c)).exit).toBe(EXIT.OK);
    st.ledger.find((x) => x.file === 'seed')!.sha256 = 'e'.repeat(64);
    st.objects.pop();
    const { api, c } = mk(st);
    await expect(run(c, { resume: true })).rejects.toThrow(/seed/);
    expect(writes(api.calls)).toHaveLength(0);
  });
  it('种子事务带运行标记（application_name）与 lock_timeout', () => {
    const ids = { admin: 'a', moderator: 'm', user: 'u', banned: 'b' };
    const s = E.seedTx(ids, 'r1').sql;
    expect(s).toMatch(/set local application_name = 'az-init:r1:seed'/);
    expect(s).toMatch(/set local lock_timeout/);
  });
  it('种子事务超时、标记会话仍在跑 → exit 3（still-running），不重试', async () => {
    let marked = false;
    let sent = 0;
    const st = fresh();
    const { c } = mk(st, {
      onQuery: (q) => {
        if (!q.includes('/* az-init:r1:seed */')) return undefined;
        sent++;
        marked = q.includes("application_name = 'az-init:r1:seed'");
        throw new Error('client-timeout');
      },
      // 假服务器只认得带 application_name 的会话（和真实 pg_stat_activity 一样）
      onReadOnly: (q) =>
        q.includes('as v') && q.includes(':seed') ? { v: { ledger: 0, running: marked ? 1 : 0 } } : undefined,
    });
    const r = await run(c);
    expect(sent).toBe(1);
    expect(r.exit).toBe(EXIT.UNKNOWN);
    expect(r.results.at(-1).outcome).toBe('still-running');
  });
});

describe('第七轮 ④ 账号：无邮件路径 + 安全交接', () => {
  it('Auth Admin 建号带 email_confirm、强密码与运行标记 app_metadata.az_init_run', async () => {
    const st = fresh();
    const { api, c } = mk(st);
    expect((await run(c)).exit).toBe(EXIT.OK);
    const bodies = api.calls
      .filter((x) => x.url.endsWith('/auth/v1/admin/users') && x.method === 'POST')
      .map((x) => JSON.parse(x.body));
    expect(bodies).toHaveLength(4);
    for (const b of bodies) {
      expect(b.email_confirm).toBe(true);
      expect(b.app_metadata?.az_init_run).toBe('r1');
      expect(String(b.password).length).toBeGreaterThanOrEqual(24);
    }
  });
  it('fileHandoff：只允许仓库外绝对路径；已存在拒绝；文件 0600、目录 0700', async () => {
    expect(typeof E.fileHandoff).toBe('function');
    expect(() => E.fileHandoff(path.resolve('ops/x.jsonl'))).toThrow(Refused);
    expect(() => E.fileHandoff('relative.jsonl')).toThrow(Refused);
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'r7-ho-')), 'sub');
    const f = path.join(dir, 'accounts.jsonl');
    const h = E.fileHandoff(f);
    await h.write('a@example.com', 'pw-1', 'id-1', { run_id: 'r1', attempt_id: 'a1' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => E.fileHandoff(f)).toThrow(/已存在/);
    writeFileSync(path.join(dir, 'x'), '');
  });
  it('execute + 文件交接：4 个账号的密码只在 Admin 请求体与 0600 文件里，日志 / trace / 结果没有', async () => {
    const st = fresh();
    const trace: unknown[] = [];
    const logs: string[] = [];
    const { api, c } = mk(st, {}, trace);
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'r7-ho2-')), 'h', 'accounts.jsonl');
    const r = await run(c, { handoff: E.fileHandoff(f), log: (s: string) => logs.push(s) });
    expect(r.exit).toBe(EXIT.OK);
    const lines = readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.email).sort()).toEqual(SYNTHETIC_USERS.map((u: any) => u.email).sort());
    for (const l of lines) expect(st.users.find((u) => u.email === l.email)!.password).toBe(l.password);
    const blob = JSON.stringify({ logs, trace, r });
    for (const l of lines) expect(blob).not.toContain(l.password);
    expect(api.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);
  });
  it('CLI execute 必须显式选择交接方式（--handoff-file <仓库外路径> 或 --handoff discard），否则不发任何请求', async () => {
    let called = 0;
    const sentinel = (() => {
      called++;
      throw new Error('NETWORK');
    }) as unknown as typeof fetch;
    const code = await quiet(() =>
      E.main(['execute', '--execute', '--confirm-ref', TEST_REF], { SBTEST_OWNER_APPROVAL: 'x' }, sentinel),
    );
    expect(code).toBe(EXIT.REFUSED);
    expect(called).toBe(0);
    const code2 = await quiet(() =>
      E.main(
        ['execute', '--execute', '--confirm-ref', TEST_REF, '--handoff-file', path.resolve('x.jsonl')],
        { SBTEST_OWNER_APPROVAL: 'x' },
        sentinel,
      ),
    );
    expect(code2).toBe(EXIT.REFUSED);
    expect(called).toBe(0);
  });
});

describe('第七轮 ④ 续跑：部分账号 / 4 个账号已建、种子未提交 → 核对后接管', () => {
  it('部分账号（2 个，带本次运行标记）→ 接管 2 个、补建 2 个、提交种子、V1 全过', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: [adoptable('admin'), adoptable('user')],
    });
    const { api, c } = mk(st);
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    const created = api.calls
      .filter((x) => x.url.endsWith('/auth/v1/admin/users') && x.method === 'POST')
      .map((x) => JSON.parse(x.body).email)
      .sort();
    expect(created).toEqual([synth('banned').email, synth('moderator').email].sort());
    expect(r.results.filter((x: { outcome: string }) => x.outcome === 'adopted')).toHaveLength(2);
    expect(st.ledger.find((x) => x.file === 'seed')).toBeDefined();
  });
  it('4 个账号已建、种子未提交 → 全部接管、不建号、提交种子、V1 全过', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k)),
    });
    const { api, c } = mk(st);
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
    expect(api.calls.some((x) => x.url.endsWith('/auth/v1/admin/users') && x.method === 'POST')).toBe(false);
  });
  it('接管 + 文件交接 + 显式改密（第八轮：必须列出并单独确认）：被接管账号经 Admin PUT 换新密码，交接文件 4 条都可用', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: [adoptable('admin'), adoptable('moderator')],
    });
    const { api, c } = mk(st);
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'r7-ho3-')), 'h', 'accounts.jsonl');
    const both = [synth('admin').email, synth('moderator').email];
    const r = await run(c, {
      resume: true,
      handoff: E.fileHandoff(f, { attemptId: 'a1' }),
      rotate: { accounts: both, confirm: both },
    });
    expect(r.exit).toBe(EXIT.OK);
    expect(
      api.calls.filter((x) => x.method === 'PUT' && x.url.includes('/auth/v1/admin/users/')),
    ).toHaveLength(2);
    const lines = readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(st.users.find((u) => u.email === l.email)!.password).toBe(l.password);
  });
  const badAcc: [string, Record<string, unknown>][] = [
    ['没有运行标记', { run: null }],
    ['别的运行的标记', { run: 'other-run' }],
    ['邮箱未确认', { confirmed: false }],
    ['多了 github 身份', { providers: ['email', 'github'] }],
    ['名称元数据不符', { name: '别人' }],
  ];
  for (const [label, o] of badAcc)
    it(`已有账号${label} → 拒绝接管（附人工核对步骤），不发写请求`, async () => {
      const st = fresh({ azInit: true, ledger: ledgerUpTo(19), users: [{ ...adoptable('admin'), ...o }] });
      const { api, c } = mk(st);
      await expect(run(c, { resume: true })).rejects.toThrow(/接管|人工核对/);
      expect(writes(api.calls)).toHaveLength(0);
    });
  it('迁移未完成却已有合成账号 → 状态矛盾，拒绝', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(10), users: [adoptable('admin')] });
    const { api, c } = mk(st);
    await expect(run(c, { resume: true })).rejects.toThrow(/矛盾/);
    expect(writes(api.calls)).toHaveLength(0);
  });
  it('RESUME_MATRIX 每一种状态都写进 ops/SBTEST-INIT.md（文档与代码一致）', () => {
    expect(Array.isArray(E.RESUME_MATRIX)).toBe(true);
    expect(E.RESUME_MATRIX.length).toBeGreaterThanOrEqual(8);
    const doc = readFileSync('ops/SBTEST-INIT.md', 'utf8');
    for (const row of E.RESUME_MATRIX) {
      expect(doc).toContain(row.state);
      expect(doc).toContain(row.action);
    }
  });
});

describe('第七轮 ④ 影响清单与回退表述', () => {
  it('影响清单：迁移自带行 9、账号相关行、种子新增行合计 12、资料更新 3 分开列；不默认建议删除 / 重建 azsou-test', () => {
    const md = E.impactMarkdown(IMPACT, MANIFEST);
    const sum = (rows: { rows: number }[]) => rows.reduce((a, r) => a + Number(r.rows), 0);
    expect(sum(IMPACT.seed_rows)).toBe(12);
    expect(md).toMatch(/迁移自带的行[^\n]*合计 9/);
    expect(md).toMatch(/账号及关联行/);
    expect(md).toMatch(/种子新增行[^\n]*合计 12/);
    expect(md).toMatch(/资料更新[^\n]*3/);
    expect(md).not.toMatch(/重建 azsou-test|删除 \/ 重建/);
    // 提交的 init-impact.md = impactMarkdown 的输出（只差 prettier 的表格对齐空白）
    const norm = (s: string) =>
      s
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\| ?/g, '|')
        .replace(/-{3,}/g, '---')
        .trim();
    const real = JSON.parse(readFileSync('ops/sbtest/init-manifest.json', 'utf8'));
    expect(norm(readFileSync('ops/sbtest/init-impact.md', 'utf8'))).toBe(
      norm(E.impactMarkdown(IMPACT, real)),
    );
  });
  it('操作手册不再把删除 / 重建 azsou-test 当作回退办法', () => {
    const doc = readFileSync('ops/SBTEST-INIT.md', 'utf8');
    expect(doc).not.toMatch(/整体回退 = 删除 \/ 重建|删除 \/ 重建 azsou-test/);
  });
});

describe('对照：未改动的正常路径仍通过', () => {
  it('全新执行 → exit 0', async () => {
    const { c } = mk(fresh());
    expect((await run(c)).exit).toBe(EXIT.OK);
  });
  it('env-token 只认回环；injected 默认基址', () => {
    expect(E.resolveEndpoints({ mode: 'env-token', mgmtBase: FAKE_MG, projectBase: FAKE_PJ }).mode).toBe(
      'env-token',
    );
    expect(existsSync('ops/SBTEST-INIT.md')).toBe(true);
    expect(SHA).toHaveLength(40);
  });
});
