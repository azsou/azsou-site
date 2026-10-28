/**
 * I01 真实链路验收脚本的退出码（站长 2026-10-28 第五轮）：BLOCKED / 部分运行必须非 0；
 * 只有每个预期用例都执行且通过才是 0。跑的是真实脚本（子进程），人工证据是临时目录里的真实文件——
 * 所有用例都由人工证据或离线阻塞决定，一个网络请求都不会发（fetch 在子进程里被替换成直接抛错的哨兵来证明这一点）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, EXPECTED, MANUAL_CHECKLIST, summarize } from '../../scripts/i01/real-acceptance.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/i01/real-acceptance.mjs');
const SITE = 'https://azsou-site-git-candidate-azsou.vercel.app';
const ENV = {
  I01_CONFIRM_ISOLATED: '1',
  I01_SUPABASE_URL: 'https://ovvfwkmqlejcpatmfqcd.supabase.co',
  I01_SUPABASE_ANON_KEY: 'sb_publishable_test',
  I01_SITE_URL: SITE,
};
// 子进程里把 fetch 换成哨兵：任何网络请求都会让该用例 fail（从而让「全部通过 → 0」的断言失败）
const NO_NET = `--import=data:text/javascript,globalThis.fetch=()=>{throw new Error('NETWORK_CALLED')}`;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4580000000049454e44ae426082',
  'hex',
);

const GOOD_OBS: Record<string, Record<string, unknown>> = {
  'T046-1': {
    verify_redirect_origin: SITE,
    verify_redirect_path: '/auth/callback/',
    session_established: true,
    replay_rejected: true,
  },
  'T046-2': { verify_redirect_origin: SITE, new_password_login_ok: true, replay_rejected: true },
  'T046-3': { landing_origins: [SITE, SITE, SITE] },
  'T046-4': { user_status: 401, verify_session_issued: false },
  'T046-5': {
    turnstile_real_key: true,
    register_api_status: 200,
    fake_token_status: 400,
    rate_limit_status: 429,
  },
  'T046-6': {
    final_origin: SITE,
    final_path: '/forum/',
    code_replay_rejected: true,
    bad_state_rejected: true,
  },
  T074: { vectors_total: 12, vectors_rejected_or_idempotent: 12, offsite_navigations: 0 },
};

type Art = { kind: string; path: string; sha256: string };
type Step = { result: string; performed_at: string; artifacts: Art[]; observations: Record<string, unknown> };
type Manifest = {
  project_ref: string;
  site_origin: string;
  candidate_sha: string;
  operator: string;
  steps: Record<string, Step>;
};

function evidence(ids: string[], tweak?: (m: Manifest, dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i01-ev-'));
  const steps: Record<string, Step> = {};
  for (const id of ids) {
    const artifacts = Object.keys(MANUAL_CHECKLIST[id as keyof typeof MANUAL_CHECKLIST].artifacts).map(
      (kind) => {
        const rel = `${id}-${kind}.png`;
        fs.writeFileSync(path.join(dir, rel), PNG);
        return { kind, path: rel, sha256: createHash('sha256').update(PNG).digest('hex') };
      },
    );
    steps[id] = {
      result: 'pass',
      performed_at: new Date(Date.now() - 3600_000).toISOString(),
      artifacts,
      observations: GOOD_OBS[id],
    };
  }
  const m = {
    project_ref: 'ovvfwkmqlejcpatmfqcd',
    site_origin: SITE,
    candidate_sha: 'a'.repeat(40),
    operator: '站长',
    steps,
  };
  tweak?.(m, dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}

function run(args: string[], env: Record<string, string> = ENV) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i01-out-'));
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('I01_')),
  ) as Record<string, string>;
  const r = spawnSync(process.execPath, [NO_NET, SCRIPT, ...args], {
    cwd: out,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const report = fs.existsSync(path.join(out, 'test-results/i01-real/report.json'))
    ? JSON.parse(fs.readFileSync(path.join(out, 'test-results/i01-real/report.json'), 'utf8'))
    : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report };
}
const ALL = EXPECTED.map((e) => e.id);

describe('summarize（预期数 vs 执行数）', () => {
  const pass = (id: string) => ({ id, status: 'pass' });
  it('全部执行且通过 → 0', () => expect(summarize(ALL.map(pass)).exitCode).toBe(EXIT.PASS));
  it('有阻塞 → 3', () =>
    expect(summarize([...ALL.slice(1).map(pass), { id: ALL[0], status: 'blocked' }]).exitCode).toBe(
      EXIT.INCOMPLETE,
    ));
  it('少执行一个 → 3', () => expect(summarize(ALL.slice(1).map(pass)).exitCode).toBe(EXIT.INCOMPLETE));
  it('一个都没执行 → 3（不是 0）', () => expect(summarize([]).exitCode).toBe(EXIT.INCOMPLETE));
  it('有失败 → 1（优先于阻塞）', () =>
    expect(
      summarize([
        { id: ALL[0], status: 'fail' },
        { id: ALL[1], status: 'blocked' },
      ]).exitCode,
    ).toBe(EXIT.FAIL));
  it('重复 id 不能凑数', () =>
    expect(summarize([...ALL.slice(1).map(pass), pass(ALL[1])]).exitCode).toBe(EXIT.INCOMPLETE));
});

describe('真实脚本退出码（子进程，无网络）', () => {
  it('缺前提 → 2，不发请求', () => {
    const r = run([], {});
    expect(r.status).toBe(EXIT.PRECONDITION);
    expect(r.stderr).toMatch(/未发出任何请求/);
  });

  it.each([
    ['生产项目', 'https://abryflgoljltyakthtql.supabase.co'],
    ['清单外项目', 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co'],
    ['本机栈（真实验收不收）', 'http://127.0.0.1:54321'],
  ])('目标是%s → 2', (_l, url) => {
    expect(run([], { ...ENV, I01_SUPABASE_URL: url }).status).toBe(EXIT.PRECONDITION);
  });

  it('生产站点当预览站 → 2', () => {
    expect(run([], { ...ENV, I01_SITE_URL: 'https://azsou.com' }).status).toBe(EXIT.PRECONDITION);
  });

  it('全部人工证据合格 → 0，执行数 = 预期数', () => {
    const r = run([`--manual-evidence=${evidence(ALL)}`]);
    expect(r.stdout).toMatch(/VERDICT PASS/);
    expect(r.status).toBe(EXIT.PASS);
    expect(r.report.summary).toMatchObject({
      expected: ALL.length,
      executed: ALL.length,
      notRun: [],
      blocked: [],
    });
    expect(r.stdout + r.stderr).not.toMatch(/NETWORK_CALLED/);
  });

  it('BLOCKED：缺 T074 的证据（离线阻塞）→ 3', () => {
    const r = run([`--manual-evidence=${evidence(ALL.filter((i) => i !== 'T074'))}`]);
    expect(r.status).toBe(EXIT.INCOMPLETE);
    expect(r.report.summary.blocked).toEqual(['T074']);
  });

  it('部分运行：--only 只跑一个 → 3（即使它通过）', () => {
    const r = run([`--manual-evidence=${evidence(ALL)}`, '--only=T046-5']);
    expect(r.report.summary).toMatchObject({ executed: 1, passed: ['T046-5'] });
    expect(r.status).toBe(EXIT.INCOMPLETE);
  });

  it('产物哈希被改 → 1', () => {
    const dir = evidence(ALL, (_m, d) => fs.appendFileSync(path.join(d, 'T046-6-final-signed-in.png'), 'x'));
    const r = run([`--manual-evidence=${dir}`]);
    expect(r.status).toBe(EXIT.FAIL);
    expect(JSON.stringify(r.report.results)).toMatch(/sha256 与清单不一致/);
  });

  it.each([
    [
      '观测值不满足（OAuth 落到外站）',
      (m: Manifest) => (m.steps['T046-6'].observations.final_origin = 'https://evil.example'),
    ],
    ['缺产物', (m: Manifest) => m.steps['T046-5'].artifacts.pop()],
    ['执行人记录失败', (m: Manifest) => (m.steps['T046-1'].result = 'fail')],
    ['证据不是 azsou-test', (m: Manifest) => (m.project_ref = 'abryflgoljltyakthtql')],
    ['候选 SHA 不完整', (m: Manifest) => (m.candidate_sha = 'abc123')],
    ['产物路径逃出目录', (m: Manifest) => (m.steps['T074'].artifacts[0].path = '../x.png')],
  ])('%s → 1', (_l, tweak) => {
    expect(run([`--manual-evidence=${evidence(ALL, tweak)}`]).status).toBe(EXIT.FAIL);
  });
});
