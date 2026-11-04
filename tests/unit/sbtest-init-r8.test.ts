/**
 * azsou-test 初始化执行器——第八轮（站长 2026-10-29 round 8，B 尾项）回归：先在当前代码上写失败用例（走真实调用路径：
 * execute / --resume / V1 / CLI main），记录失败，再修。
 *  B1 严格结果解析（单一共享解析器）：V1.status 收到 [{}] 或 [] 必须不通过；续跑的运行中会话查询 n 缺失 / null / 非数字
 *     不能经 Number(...) > 0 放行 → 不确定 / 拒绝；区分合法的 rows:null 与缺少 rows 字段；任何不确定结果 → 不再写。
 *  B2 交接 / 续跑一致：交接文件 run_id = 实际沿用的账本 run_id，另加每次调用的 attempt_id；仓库外路径检查解析符号链接、
 *     核对目录 0700 / 文件 0600 / 属主；种子已提交 + 只补文件的续跑不得隐式改密，改密只能显式列出账号并单独确认；
 *     正式初始化（真实目标）不允许 --handoff discard。
 *  B3 措辞：401 不能一律解释为「没有注入」（No API key found / Invalid API key / 其他）；GET /v1/projects 403 不能说成「只授权单个项目」。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import {
  MANIFEST,
  fakeApi,
  fresh,
  mk,
  run,
  writes,
  type State,
  type User,
  SPAWN_TIMEOUT,
} from './sbtest-fake';

// 第九轮：不再整文件放宽超时；只有真正起子进程（git）的用例单独给 SPAWN_TIMEOUT（见 sbtest-fake.ts）

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF, Refused } = E;

/** CLI 走真实清单 ops/sbtest/init-manifest.json（名称与 sha256 和仓库一致） */
const REAL = JSON.parse(readFileSync('ops/sbtest/init-manifest.json', 'utf8'));
const realLedgerUpTo = (n: number, runId = 'old1') =>
  REAL.migrations
    .slice(0, n)
    .map((m: { name: string; sha256: string }) => ({ run_id: runId, file: m.name, sha256: m.sha256 }));
const ledgerUpTo = (n: number, runId = 'old1') =>
  MANIFEST.migrations
    .slice(0, n)
    .map((m: { name: string; sha256: string }) => ({ run_id: runId, file: m.name, sha256: m.sha256 }));
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
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r8-${p}-`));
const sentinelFetch = () => {
  const s = { called: 0 };
  const f = (() => {
    s.called++;
    throw new Error('NETWORK');
  }) as unknown as typeof fetch;
  return { s, f };
};
/** 种子已提交、4 个账号都在、文件未上传（只差 F1）的状态 */
const seedDoneFilesMissing = (real = false): State => {
  const users = ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k));
  const seedSha = E.expectedSeedSha(users, 'old1');
  return fresh({
    azInit: true,
    ledger: [
      ...(real ? realLedgerUpTo(19) : ledgerUpTo(19)),
      { run_id: 'old1', file: 'seed', sha256: seedSha },
    ],
    users,
    seeded: true,
  });
};
/** 真实 status.sql 文本会被通用假回答误配（以前误配成 [{}] 也会被当成「全部 true」——正是 B1 修的问题）：CLI 用例显式回答 */
const statusOk = (q: string) => (q.includes('json_agg(x) as rows') ? { rows: null } : undefined);
const puts = (calls: { method: string; url: string }[]) =>
  calls.filter((x) => x.method === 'PUT' && x.url.includes('/auth/v1/admin/users/'));
const isV1Status = (q: string) =>
  q.includes('as rows') && q.includes('where not ok') && !q.includes('step <=');

describe('第八轮 B1 严格结果解析（单一共享解析器）', () => {
  for (const [label, ans] of [
    ['[{}]（缺 rows 字段）', () => ({})],
    ['[]（没有行）', () => Response.json([], { status: 201 })],
    ['[{rows: "x"}]（rows 不是数组 / null）', () => ({ rows: 'x' })],
    ['两行', () => Response.json([{ rows: null }, { rows: null }], { status: 201 })],
  ] as [string, () => unknown][])
    it(`execute → V1.status 收到 ${label} → 不通过（不确定，exit 3），不是「全部 true」`, async () => {
      const st = fresh();
      const { c } = mk(st, { onReadOnly: (q) => (isV1Status(q) ? ans() : undefined) });
      const r = await run(c);
      expect(r.exit).not.toBe(EXIT.OK);
      expect(r.exit).toBe(EXIT.UNKNOWN);
      const chk = r.v1.checks.find((x: { id: string }) => x.id === 'V1.status');
      expect(chk.ok).toBe(false);
    });
  it('execute → V1.status 合法的 rows:null（json_agg 空集）→ 通过（与缺字段区分）', async () => {
    const { c } = mk(fresh(), { onReadOnly: (q) => (isV1Status(q) ? { rows: null } : undefined) });
    const r = await run(c);
    expect(r.exit).toBe(EXIT.OK);
    expect(r.v1.checks.find((x: { id: string }) => x.id === 'V1.status').ok).toBe(true);
  });

  const isRunning = (q: string) => q.includes('as n from pg_stat_activity');
  for (const [label, ans] of [
    ['{}（缺 n）', () => ({})],
    ['{n: null}', () => ({ n: null })],
    ['{n: "abc"}', () => ({ n: 'abc' })],
    ['{n: -1}', () => ({ n: -1 })],
    ['[]（没有行）', () => Response.json([], { status: 201 })],
  ] as [string, () => unknown][])
    it(`--resume：运行中会话查询 ${label} → 不确定，拒绝，一个写请求都不发`, async () => {
      const st = fresh({ azInit: true, ledger: ledgerUpTo(3) });
      const { api, c } = mk(st, { onReadOnly: (q) => (isRunning(q) ? ans() : undefined) });
      await expect(run(c, { resume: true })).rejects.toThrow(Refused);
      expect(writes(api.calls)).toHaveLength(0);
    });
  it('--resume：运行中会话 n = 0（合法）→ 继续续跑', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(3) });
    const { c } = mk(st, { onReadOnly: (q) => (isRunning(q) ? { n: 0 } : undefined) });
    const r = await run(c, { resume: true });
    expect(r.exit).toBe(EXIT.OK);
  });
  it('--resume：已提交步骤的 status 核对收到 [{}] → 不确定，拒绝，不写（以前被当成「全部生效」）', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(5) });
    const { api, c } = mk(st, {
      onReadOnly: (q) => (q.includes('as rows') && q.includes("step <= '0005'") ? {} : undefined),
    });
    await expect(run(c, { resume: true })).rejects.toThrow(Refused);
    expect(writes(api.calls)).toHaveLength(0);
  });
  it(
    'CLI execute --resume：运行中会话查询缺 n → 退出码 2，没有写请求，运行记录写「不确定」',
    async () => {
      const st = fresh({ azInit: true, ledger: realLedgerUpTo(3) });
      const api = fakeApi(st, { onReadOnly: (q) => (isRunning(q) ? {} : undefined) });
      const dir = tmp('cli-n');
      const rec = path.join(dir, 'rec.md');
      const code = await quiet(() =>
        E.main(
          [
            'execute',
            '--execute',
            '--resume',
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
      expect(code).toBe(EXIT.REFUSED);
      expect(writes(api.calls)).toHaveLength(0);
      expect(readFileSync(rec, 'utf8')).toMatch(/不确定/);
    },
    SPAWN_TIMEOUT,
  );
  it('共享解析器 parseOneRow：恰好 1 行、是对象、字段存在（值可以是 null）；其余一律 Uncertain', () => {
    expect(typeof E.parseOneRow).toBe('function');
    expect(E.parseOneRow([{ rows: null }], 'rows')).toBeNull();
    expect(E.parseOneRow([{ n: 0 }], 'n')).toBe(0);
    for (const bad of [[{}], [], null, {}, [{ rows: 1 }, { rows: 2 }], [null], ['x']])
      expect(() => E.parseOneRow(bad, 'rows')).toThrow(E.Uncertain);
  });
});

describe('第八轮 B2 交接 / 续跑一致', () => {
  it(
    'CLI --resume（部分账号）：交接文件 run_id = 账本沿用的 run_id；另有本次调用的 attempt_id（≠ run_id）；运行记录写 attempt_id',
    async () => {
      const st = fresh({
        azInit: true,
        ledger: realLedgerUpTo(19),
        users: [adoptable('admin'), adoptable('user')],
      });
      const api = fakeApi(st, { onReadOnly: statusOk });
      const dir = tmp('runid');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      const code = await quiet(() =>
        E.main(
          [
            'execute',
            '--execute',
            '--resume',
            '--confirm-ref',
            TEST_REF,
            '--handoff-file',
            hf,
            '--record',
            rec,
          ],
          { SBTEST_OWNER_APPROVAL: 'test' },
          api.fetchImpl,
        ),
      );
      expect(code).toBe(EXIT.OK);
      const lines = readFileSync(hf, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l.run_id).toBe('old1');
        expect(l.attempt_id).toMatch(/^\d{8}T\d{6}-[0-9a-f]{6}$/);
        expect(l.attempt_id).not.toBe(l.run_id);
      }
      expect(new Set(st.ledger.map((r) => r.run_id))).toEqual(new Set(['old1']));
      expect(readFileSync(rec, 'utf8')).toContain(lines[0].attempt_id);
    },
    SPAWN_TIMEOUT,
  );
  it('种子已提交 + 只补文件的续跑（带交接文件）：不隐式改密——没有任何 PUT，旧密码不变', async () => {
    const st = seedDoneFilesMissing();
    const { api, c } = mk(st);
    const f = path.join(tmp('nrot'), 'h', 'a.jsonl');
    const r = await run(c, { resume: true, handoff: E.fileHandoff(f, { attemptId: 'a1' }) });
    expect(r.exit).toBe(EXIT.OK);
    expect(puts(api.calls)).toHaveLength(0);
    for (const u of st.users) expect(u.password).toBe(`old-pw-${u.key}`);
  });
  it('部分账号续跑（带交接文件、未显式要求改密）：被接管账号也不改密，只交接新建的账号', async () => {
    const st = fresh({
      azInit: true,
      ledger: ledgerUpTo(19),
      users: [adoptable('admin'), adoptable('moderator')],
    });
    const { api, c } = mk(st);
    const f = path.join(tmp('nrot2'), 'h', 'a.jsonl');
    const r = await run(c, { resume: true, handoff: E.fileHandoff(f, { attemptId: 'a1' }) });
    expect(r.exit).toBe(EXIT.OK);
    expect(puts(api.calls)).toHaveLength(0);
    const emails = readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).email)
      .sort();
    expect(emails).toEqual([synth('banned').email, synth('user').email].sort());
  });
  it(
    'CLI 显式改密：--rotate-passwords 列出账号但缺 --confirm-rotate（或不一致）→ 拒绝且不发请求；一致 → 只改列出的账号',
    async () => {
      const { s, f } = sentinelFetch();
      const dir = tmp('rot');
      const a = synth('admin').email;
      const m = synth('moderator').email;
      const base = ['execute', '--execute', '--resume', '--confirm-ref', TEST_REF];
      expect(
        await quiet(() =>
          E.main(
            [...base, '--handoff-file', path.join(dir, 'h1', 'a.jsonl'), '--rotate-passwords', a],
            { SBTEST_OWNER_APPROVAL: 't' },
            f,
          ),
        ),
      ).toBe(EXIT.REFUSED);
      expect(
        await quiet(() =>
          E.main(
            [
              ...base,
              '--handoff-file',
              path.join(dir, 'h2', 'a.jsonl'),
              '--rotate-passwords',
              a,
              '--confirm-rotate',
              m,
            ],
            { SBTEST_OWNER_APPROVAL: 't' },
            f,
          ),
        ),
      ).toBe(EXIT.REFUSED);
      expect(s.called).toBe(0);
      const st = seedDoneFilesMissing(true);
      const api = fakeApi(st, { onReadOnly: statusOk });
      const hf = path.join(dir, 'h3', 'a.jsonl');
      const code = await quiet(() =>
        E.main(
          [...base, '--handoff-file', hf, '--rotate-passwords', a, '--confirm-rotate', a],
          { SBTEST_OWNER_APPROVAL: 't' },
          api.fetchImpl,
        ),
      );
      expect(code).toBe(EXIT.OK);
      expect(puts(api.calls)).toHaveLength(1);
      const lines = readFileSync(hf, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.email)).toEqual([a]);
      expect(st.users.find((u) => u.email === a)!.password).toBe(lines[0].password);
      expect(st.users.find((u) => u.email === m)!.password).toBe('old-pw-moderator');
    },
    SPAWN_TIMEOUT,
  );
  it('显式改密列出的账号不在被接管账号里 → 拒绝，不写', async () => {
    const st = fresh({ azInit: true, ledger: ledgerUpTo(19), users: [adoptable('admin')] });
    const { api, c } = mk(st);
    const f = path.join(tmp('rot2'), 'h', 'a.jsonl');
    await expect(
      run(c, {
        resume: true,
        handoff: E.fileHandoff(f, { attemptId: 'a1' }),
        rotate: { accounts: [synth('banned').email], confirm: [synth('banned').email] },
      }),
    ).rejects.toThrow(Refused);
    expect(writes(api.calls)).toHaveLength(0);
  });

  it('fileHandoff：路径里有符号链接指向仓库 → 拒绝，仓库里不留文件', () => {
    const repo = tmp('repo');
    mkdirSync(path.join(repo, 'inner'), { mode: 0o700 });
    const out = tmp('out');
    symlinkSync(path.join(repo, 'inner'), path.join(out, 'link'));
    expect(() => E.fileHandoff(path.join(out, 'link', 'sub', 'a.jsonl'), { repoRoot: repo })).toThrow(
      Refused,
    );
    expect(existsSync(path.join(repo, 'inner', 'sub'))).toBe(false);
    // 直接指向仓库根的链接也拒绝
    symlinkSync(repo, path.join(out, 'rootlink'));
    expect(() => E.fileHandoff(path.join(out, 'rootlink', 'a.jsonl'), { repoRoot: repo })).toThrow(Refused);
    expect(readdirSync(repo)).toEqual(['inner']);
  });
  it('fileHandoff：仓库根本身经符号链接给出时也按真实路径比较', () => {
    const real = tmp('realrepo');
    const out = tmp('out2');
    symlinkSync(real, path.join(out, 'repo-alias'));
    expect(() =>
      E.fileHandoff(path.join(real, 'x', 'a.jsonl'), { repoRoot: path.join(out, 'repo-alias') }),
    ).toThrow(Refused);
    expect(existsSync(path.join(real, 'x'))).toBe(false);
  });
  it('fileHandoff：已存在的目录不是 0700（例如 0755）→ 拒绝（不改它的权限）', () => {
    const d = tmp('perm');
    chmodSync(d, 0o755);
    expect(() => E.fileHandoff(path.join(d, 'a.jsonl'))).toThrow(Refused);
    expect(statSync(d).mode & 0o777).toBe(0o755);
    expect(existsSync(path.join(d, 'a.jsonl'))).toBe(false);
  });
  it('fileHandoff：目录属主不是当前用户 → 拒绝', () => {
    const d = path.join(tmp('own'), 'h');
    expect(() =>
      E.fileHandoff(path.join(d, 'a.jsonl'), { expectUid: (process.getuid?.() ?? 0) + 1 }),
    ).toThrow(/属主/);
  });
  it('fileHandoff：正常路径 → 目录 0700、文件 0600、属主是当前用户；每行带 run_id 与 attempt_id', () => {
    const d = path.join(tmp('ok'), 'h');
    const f = path.join(d, 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: '20261029T110000-abcdef' });
    h.write('a@example.com', 'pw', '00000000-0000-0000-0000-000000000000', { run_id: 'old1' });
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(f).uid).toBe(process.getuid?.());
    const l = JSON.parse(readFileSync(f, 'utf8'));
    expect(l.run_id).toBe('old1');
    expect(l.attempt_id).toBe('20261029T110000-abcdef');
    expect(() => h.write('b@example.com', 'pw', null, {})).toThrow(Refused);
  });
  it(
    'CLI execute：--handoff-file 经符号链接指向仓库 → 退出码 2，不发请求，仓库里不留文件',
    async () => {
      const probe = path.join(process.cwd(), `.r8-probe-${process.pid}`);
      mkdirSync(probe, { mode: 0o700 });
      try {
        const out = tmp('cli-link');
        symlinkSync(probe, path.join(out, 'link'));
        const { s, f } = sentinelFetch();
        const code = await quiet(() =>
          E.main(
            [
              'execute',
              '--execute',
              '--confirm-ref',
              TEST_REF,
              '--handoff-file',
              path.join(out, 'link', 'h', 'a.jsonl'),
            ],
            { SBTEST_OWNER_APPROVAL: 'x' },
            f,
          ),
        );
        expect(code).toBe(EXIT.REFUSED);
        expect(s.called).toBe(0);
        expect(readdirSync(probe)).toEqual([]);
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'CLI 正式初始化（injected 真实目标）+ --handoff discard → 退出码 2，一个请求都不发',
    async () => {
      const { s, f } = sentinelFetch();
      const code = await quiet(() =>
        E.main(
          ['execute', '--execute', '--confirm-ref', TEST_REF, '--handoff', 'discard'],
          { SBTEST_OWNER_APPROVAL: 'x' },
          f,
        ),
      );
      expect(code).toBe(EXIT.REFUSED);
      expect(s.called).toBe(0);
    },
    SPAWN_TIMEOUT,
  );
  it('execute API：真实目标（injected）且交接为 discard / 未给 → 拒绝，一个请求都不发', async () => {
    for (const handoff of ['discard', undefined]) {
      const { s, f } = sentinelFetch();
      const c = E.client({ mode: 'injected', fetchImpl: f });
      await expect(run(c, { handoff })).rejects.toThrow(Refused);
      expect(s.called).toBe(0);
    }
  });
  it('本机假服务器（env-token 回环）仍可用 discard（只用于测试 / 演练）', async () => {
    const { c } = mk(fresh());
    expect((await run(c, { handoff: 'discard' })).exit).toBe(EXIT.OK);
  });
});

describe('第八轮 B3 措辞：401 分类 / 403 不是范围证明', () => {
  const pre = async (adminList: State['adminList']) => {
    const dir = tmp('401');
    const rec = path.join(dir, 'rec.md');
    const api = fakeApi(fresh({ adminList }));
    const code = await quiet(() => E.main(['preflight', '--record', rec], {}, api.fetchImpl));
    return { code, md: readFileSync(rec, 'utf8') };
  };
  it('Auth Admin 401 "Invalid API key" → 记为「apikey 已送达但无效」，不说「没有注入」', async () => {
    const { code, md } = await pre({ status: 401, body: { message: 'Invalid API key' } });
    expect(code).toBe(EXIT.REFUSED);
    expect(md).toMatch(/Invalid API key/);
    expect(md).toMatch(/已送达但无效|invalid_api_key/);
    expect(md).not.toMatch(/没有注入/);
  });
  it('Auth Admin 401 "No API key found in request" → 记为「没有 apikey（未注入）」', async () => {
    const { md } = await pre({ status: 401, body: { message: 'No API key found in request' } });
    expect(md).toMatch(/No API key found/);
    expect(md).toMatch(/no_api_key/);
  });
  it('Auth Admin 401 其他（例如 GoTrue bad_jwt）→ 记为「其他 401」，不说「没有注入」', async () => {
    const { md } = await pre({ status: 401, body: { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' } });
    expect(md).toMatch(/other/);
    expect(md).not.toMatch(/没有注入/);
  });
  it('Management API 401（无法区分缺失 / 无效）→ 不断言「没有注入」', async () => {
    const api = fakeApi(fresh(), {
      any: (url) =>
        url.includes('/v1/projects/')
          ? Response.json({ message: 'Unauthorized' }, { status: 401 })
          : undefined,
    });
    const dir = tmp('401m');
    const rec = path.join(dir, 'rec.md');
    expect(await quiet(() => E.main(['preflight', '--record', rec], {}, api.fetchImpl))).toBe(EXIT.REFUSED);
    const md = readFileSync(rec, 'utf8');
    expect(md).not.toMatch(/没有注入凭据/);
    expect(md).toMatch(/无法区分/);
  });
  it('classify401：三类', () => {
    expect(E.classify401('{"message":"No API key found in request"}').kind).toBe('no_api_key');
    expect(E.classify401('{"message":"Invalid API key"}').kind).toBe('invalid_api_key');
    expect(E.classify401('{"msg":"invalid JWT"}').kind).toBe('other');
  });
  it('verifyTarget：GET /v1/projects 403 只记录，不说「只授权单个项目」/「= project-scoped」', async () => {
    const { c } = mk(fresh({ listStatus: 403 }));
    const { scope } = await E.verifyTarget(c);
    expect(scope.verdict).not.toMatch(/只授权单个项目|= ?project-scoped|符合要求/);
    expect(scope.verdict).toMatch(/不能证明/);
    const p = E.plan(MANIFEST);
    expect(JSON.stringify(p)).not.toMatch(/403 = project-scoped/);
  });
  it('文档 / 证据 / 执行器源码里没有「403 = 只授权单个项目」「401 = 没有注入」的说法', () => {
    const files = [
      'scripts/sbtest/init-executor.mjs',
      'ops/SBTEST-INIT.md',
      ...readdirSync('docs/audits/evidence/sbtest').map((f) => `docs/audits/evidence/sbtest/${f}`),
    ].filter((f) => f.endsWith('.md') || f.endsWith('.mjs'));
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/只授权单个项目/);
      expect(t, f).not.toMatch(/403 = project-scoped/);
      expect(t, f).not.toMatch(/401 = 线路上没有注入凭据/);
    }
  });
});
