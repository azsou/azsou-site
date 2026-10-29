/**
 * azsou-test 初始化执行器——第十轮（站长 2026-10-29 round 10，B 尾项）回归：交接 N = 0。
 * 种子已提交、4 个账号都在、只补文件的续跑，且没有 --rotate-passwords / --confirm-rotate：本次没有新建账号、没有改密，
 * 交接文件实际 0 行。此时：
 *  - N 以本次运行实际写进交接文件的行数为准（handoff.count()），不是推算；
 *  - 不能留下一个「需要存进 vault」的交接文件，运行记录 / 输出必须写明 N = 0、不需要任何 save_login、不得为凑数改密；
 *  - 空文件核对仍为 0 字节的普通文件后才删除；N = 0 但文件里有内容（被别的东西写过）→ 保留并要求人工核对，不删。
 * 先在当前代码上跑（失败），再修。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const E = X as any;
const { EXIT, SYNTHETIC_USERS, TEST_REF } = E;

const REAL = JSON.parse(readFileSync('ops/sbtest/init-manifest.json', 'utf8'));
const ledgerUpTo = (m: { migrations: { name: string; sha256: string }[] }, n: number, runId = 'old1') =>
  m.migrations.slice(0, n).map((x) => ({ run_id: runId, file: x.name, sha256: x.sha256 }));
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
/** 种子已提交、4 个账号都在、文件未上传（只差 F1）的状态 */
const seedDoneFilesMissing = (real = false): State => {
  const users = ['admin', 'moderator', 'user', 'banned'].map((k) => adoptable(k));
  return fresh({
    azInit: true,
    ledger: [
      ...ledgerUpTo(real ? REAL : MANIFEST, 19),
      { run_id: 'old1', file: 'seed', sha256: E.expectedSeedSha(users, 'old1') },
    ],
    users,
    seeded: true,
  });
};
const statusOk = (q: string) => (q.includes('json_agg(x) as rows') ? { rows: null } : undefined);
const puts = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === 'PUT' && c.url.includes('/auth/v1/admin/users/'));
const posts = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === 'POST' && c.url.includes('/auth/v1/admin/users'));
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), `r10-${p}-`));
const quiet = async <T>(fn: () => Promise<T>, out: string[] = []) => {
  const [l, e] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    return await fn();
  } finally {
    console.log = l;
    console.error = e;
  }
};

describe('第十轮 交接 N = 0（种子已提交 + 只补文件、没有显式改密）', () => {
  it('finishHandoff：0 行 → 写明 N = 0、不需要 save_login、不改密；空 0600 文件核对后删除', () => {
    const f = path.join(tmp('n0'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    expect(existsSync(f)).toBe(true);
    const notes: string[] = E.finishHandoff(h);
    const text = notes.join('\n');
    expect(text).toMatch(/N = 0/);
    expect(text).toMatch(/不需要.*save_login/);
    expect(text).toMatch(/不得为凑数改密/);
    expect(text).not.toMatch(/全部存进 vault/);
    expect(existsSync(f)).toBe(false);
  });
  it('finishHandoff：N > 0 → 文件保留，写明实际 N 条、全部存进 vault 才覆盖删除', () => {
    const f = path.join(tmp('n2'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    h.write(synth('admin').email, 'pw-a', 'id-a', { run_id: 'r1' });
    h.write(synth('user').email, 'pw-u', 'id-u', { run_id: 'r1' });
    const text = E.finishHandoff(h).join('\n');
    expect(text).toMatch(/N = 2 条/);
    expect(text).toMatch(/2 条全部存进 vault 才覆盖删除/);
    expect(text).not.toMatch(/pw-a|pw-u/);
    expect(readFileSync(f, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('finishHandoff：本次 0 行但文件不是空的 → 不删，保留并要求人工核对（N 以本次实际写入为准）', () => {
    const f = path.join(tmp('n0x'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    writeFileSync(f, '{"email":"x"}\n');
    const text = E.finishHandoff(h).join('\n');
    expect(text).toMatch(/N = 0/);
    expect(text).toMatch(/保留.*人工核对/);
    expect(existsSync(f)).toBe(true);
  });
  it('execute --resume（种子已提交 + 只补文件，不改密）：不建号、不改密，交接实际 0 行', async () => {
    const st = seedDoneFilesMissing();
    const { api, c } = mk(st);
    const f = path.join(tmp('n0run'), 'h', 'a.jsonl');
    const h = E.fileHandoff(f, { attemptId: 'a1' });
    const r = await run(c, { resume: true, handoff: h });
    expect(r.exit).toBe(EXIT.OK);
    expect(h.count()).toBe(0);
    expect(puts(api.calls)).toHaveLength(0);
    expect(posts(api.calls)).toHaveLength(0);
    expect(writes(api.calls).length).toBeGreaterThan(0); // 确实补了文件
    for (const u of st.users) expect(u.password).toBe(`old-pw-${u.key}`);
  });
  it(
    'CLI execute --resume（种子已提交 + 只补文件，不改密）：运行记录与输出写 N = 0、不需要 save_login；不留交接文件',
    async () => {
      const st = seedDoneFilesMissing(true);
      const api = fakeApi(st, { onReadOnly: statusOk });
      const dir = tmp('n0cli');
      const hf = path.join(dir, 'h', 'a.jsonl');
      const rec = path.join(dir, 'rec.md');
      const out: string[] = [];
      const code = await quiet(
        () =>
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
        out,
      );
      expect(code).toBe(EXIT.OK);
      expect(puts(api.calls)).toHaveLength(0);
      expect(posts(api.calls)).toHaveLength(0);
      expect(existsSync(hf)).toBe(false);
      const r = readFileSync(rec, 'utf8');
      expect(r).toMatch(/N = 0/);
      expect(r).toMatch(/不需要.*save_login/);
      expect(r).not.toMatch(/全部存进 vault/);
      expect(out.join('\n')).toMatch(/N = 0/);
    },
    SPAWN_TIMEOUT,
  );
});
