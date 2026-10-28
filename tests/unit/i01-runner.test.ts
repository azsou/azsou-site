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
import {
  EXIT,
  EXPECTED,
  MANUAL_CHECKLIST,
  summarize,
  verifyDeployment,
} from '../../scripts/i01/real-acceptance.mjs';
import { allVectors } from '../../scripts/i01/redirect-vectors.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/i01/real-acceptance.mjs');
// 第六轮 ⑤：预览站必须是该部署的唯一地址（分支别名 *-git-* 会漂移）
const SITE = 'https://azsou-site-kd7wqy8m5-azsous-projects.vercel.app';
const SHA = 'a'.repeat(40);
const DEPLOY_ID = '7387426331';
const ENV = {
  I01_CONFIRM_ISOLATED: '1',
  I01_SUPABASE_URL: 'https://ovvfwkmqlejcpatmfqcd.supabase.co',
  I01_SUPABASE_ANON_KEY: 'sb_publishable_test',
  I01_SITE_URL: SITE,
  I01_CANDIDATE_SHA: SHA,
  I01_GITHUB_DEPLOYMENT_ID: DEPLOY_ID,
};
/** GitHub Deployments API 假数据（路径 → 响应体）；子进程经 TEST_GH_FIXTURE 读 */
type Fixture = Record<string, { status?: number; body: unknown }>;
function ghFixture(
  o: { sha?: string; state?: string; envUrl?: string; env?: string; creator?: string } = {},
): Fixture {
  const base = `/repos/azsou/azsou-site/deployments/${DEPLOY_ID}`;
  return {
    [base]: {
      body: {
        id: Number(DEPLOY_ID),
        sha: o.sha ?? SHA,
        environment: o.env ?? 'Preview',
        creator: { login: o.creator ?? 'vercel[bot]' },
        created_at: '2026-10-29T00:00:00Z',
      },
    },
    [`${base}/statuses`]: {
      body: [
        {
          state: o.state ?? 'success',
          environment_url: o.envUrl ?? SITE,
          target_url: 'https://vercel.com/azsous-projects/azsou-site/5cZ2Upxoq7nxYxMXzet1RBuie72G',
          log_url: SITE,
          description: 'Deployment has completed',
        },
      ],
    },
  };
}
const fixtureFile = (fx: Fixture) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'i01-gh-')), 'gh.json');
  fs.writeFileSync(f, JSON.stringify(fx));
  return f;
};
// 子进程里把 fetch 换成哨兵：只有 api.github.com 由假数据回答（部署绑定），其余任何网络请求都抛 NETWORK_CALLED
const FAKE_FETCH = `const fs=process.getBuiltinModule('fs');const fx=process.env.TEST_GH_FIXTURE?JSON.parse(fs.readFileSync(process.env.TEST_GH_FIXTURE,'utf8')):{};globalThis.fetch=async(u)=>{u=String(u);if(u.startsWith('https://api.github.com/')){const p=new URL(u).pathname;const e=fx[p];return e?new Response(JSON.stringify(e.body),{status:e.status??200,headers:{'content-type':'application/json'}}):new Response('{}',{status:404})}throw new Error('NETWORK_CALLED')}`;
const NO_NET = `--import=data:text/javascript,${encodeURIComponent(FAKE_FETCH)}`;
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
  T074: {
    vectors_total: allVectors().length,
    vectors_executed: allVectors(),
    vectors_rejected_or_idempotent: allVectors().length,
    offsite_navigations: 0,
  },
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
      observations: structuredClone(GOOD_OBS[id]),
    };
  }
  const m = {
    project_ref: 'ovvfwkmqlejcpatmfqcd',
    site_origin: SITE,
    candidate_sha: SHA,
    operator: '站长',
    steps,
  };
  tweak?.(m, dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}

function run(args: string[], env: Record<string, string> = ENV, fx: Fixture = ghFixture()) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i01-out-'));
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('I01_')),
  ) as Record<string, string>;
  const r = spawnSync(process.execPath, [NO_NET, SCRIPT, ...args], {
    cwd: out,
    env: { ...base, ...env, TEST_GH_FIXTURE: fixtureFile(fx) },
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

describe('第六轮 ⑤ 部署绑定：实际部署的候选 SHA + 唯一预览地址 + 全表向量', () => {
  it('分支别名（*-git-*）当预览站 → 2', () => {
    const r = run([], { ...ENV, I01_SITE_URL: 'https://azsou-site-git-candidate-azsou.vercel.app' });
    expect(r.status).toBe(EXIT.PRECONDITION);
    expect(r.stderr).toMatch(/分支别名/);
  });
  it('缺 I01_CANDIDATE_SHA / I01_GITHUB_DEPLOYMENT_ID → 2', () => {
    const noSha: Record<string, string> = { ...ENV };
    delete noSha.I01_CANDIDATE_SHA;
    const noDep: Record<string, string> = { ...ENV };
    delete noDep.I01_GITHUB_DEPLOYMENT_ID;
    expect(run([], noSha).status).toBe(EXIT.PRECONDITION);
    expect(run([], noDep).status).toBe(EXIT.PRECONDITION);
  });
  it.each([
    ['deployment 的 sha 不是候选', { sha: 'b'.repeat(40) }, /sha/],
    ['部署失败（state=failure）', { state: 'failure' }, /success/],
    [
      'environment_url 不是这个预览站',
      { envUrl: 'https://azsou-site-other-azsous-projects.vercel.app' },
      /environment_url/,
    ],
    ['不是 Preview 环境', { env: 'Production' }, /Preview/],
    ['不是 Vercel 创建的', { creator: 'someone' }, /vercel\[bot\]/],
  ])('%s → 2，不发任何验收请求', (_l, o, msg) => {
    const r = run([`--manual-evidence=${evidence(ALL)}`], ENV, ghFixture(o));
    expect(r.status).toBe(EXIT.PRECONDITION);
    expect(r.stderr).toMatch(msg);
    expect(r.stdout + r.stderr).not.toMatch(/NETWORK_CALLED/);
  });
  it('GitHub deployment 查不到（404 / 未注入凭据）→ 2', () => {
    const r = run([], ENV, {});
    expect(r.status).toBe(EXIT.PRECONDITION);
    expect(r.stderr).toMatch(/HTTP 404/);
  });
  it('给了 Vercel 部署 id：出现在状态里 → 通过；对不上 → 2', () => {
    expect(
      run([`--manual-evidence=${evidence(ALL)}`], {
        ...ENV,
        I01_VERCEL_DEPLOYMENT_ID: 'dpl_5cZ2Upxoq7nxYxMXzet1RBuie72G',
      }).status,
    ).toBe(EXIT.PASS);
    expect(run([], { ...ENV, I01_VERCEL_DEPLOYMENT_ID: 'dpl_Other' }).status).toBe(EXIT.PRECONDITION);
  });
  it('通过时报告里带绑定信息（deployment id、sha、environment_url、全表条数）', () => {
    const r = run([`--manual-evidence=${evidence(ALL)}`]);
    expect(r.status).toBe(EXIT.PASS);
    expect(r.report.binding).toMatchObject({
      github_deployment_id: Number(DEPLOY_ID),
      sha: SHA,
      environment_url: SITE,
      vectors_total: allVectors().length,
    });
  });
  it.each([
    ['人工证据的 candidate_sha 不是实际部署的候选', (m: Manifest) => (m.candidate_sha = 'c'.repeat(40))],
    [
      'T074 只跑了部分向量',
      (m: Manifest) => (m.steps['T074'].observations.vectors_executed = allVectors().slice(1)),
    ],
    [
      'T074 条数凑够但有重复',
      (m: Manifest) =>
        (m.steps['T074'].observations.vectors_executed = [...allVectors().slice(1), allVectors()[1]]),
    ],
    [
      'T074 总数不是全表',
      (m: Manifest) => {
        m.steps['T074'].observations.vectors_total = 12;
        m.steps['T074'].observations.vectors_rejected_or_idempotent = 12;
      },
    ],
  ])('%s → 1', (_l, tweak) => {
    expect(run([`--manual-evidence=${evidence(ALL, tweak)}`]).status).toBe(EXIT.FAIL);
  });
  it('verifyDeployment 带 token 时加 Authorization，不带时不加（线路注入）', async () => {
    const seen: (string | undefined)[] = [];
    const fx = ghFixture();
    const f = (async (u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).authorization);
      const e = fx[new URL(u).pathname];
      return Response.json(e.body);
    }) as unknown as typeof fetch;
    const cfg = { candidateSha: SHA, ghDeploymentId: DEPLOY_ID, vercelDeploymentId: '', siteOrigin: SITE };
    expect((await verifyDeployment(cfg, { fetchImpl: f })).ok).toBe(true);
    expect((await verifyDeployment(cfg, { fetchImpl: f, token: 't' })).ok).toBe(true);
    expect(seen).toEqual([undefined, undefined, 'Bearer t', 'Bearer t']);
  });
});
