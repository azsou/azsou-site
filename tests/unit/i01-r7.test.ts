/**
 * I01 第七轮（站长 2026-10-29）回归：先在当前代码上写失败用例，再修。全部离线（假 GitHub / Vercel / Supabase / 收件箱 / 本机 http 服务器）。
 *  - 稳定候选域名不硬拒：验收前后记录「域名 → Vercel 部署 id → SHA → 候选分支头」，映射变了证据作废；开始前分支头必须 = 候选（冻结推送）。
 *  - T074：42 个 next 向量逐条记录期望 vs 实际落点；3 条合法点段路径必须落到规范化后的本站路径。
 *  - T046-4 真实过期 token；T046-2 重置后旧密码被拒、新密码可用（实现了，真实环境未执行）。
 *  - 管理通道与用户验收通道隔离：用户通道直连、只带 anon / 用户 JWT，金丝雀发现 service_role 注入就停止。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as RA from '../../scripts/i01/real-acceptance.mjs';
import { BENIGN_DOT_NEXT, EVIL_NEXT, allVectors } from '../../scripts/i01/redirect-vectors.mjs';

const CH: any = await import('../../scripts/i01/channels.mjs' as string).catch(() => ({}));
const R = RA as any;
const SB = 'https://ovvfwkmqlejcpatmfqcd.supabase.co';
const ANON = 'sb_publishable_test';
const STABLE = 'https://azsou-site-git-candidate-2026-10-27-integrated-azsous-projects.vercel.app';
const UNIQUE_HOST = 'azsou-site-kd7wqy8m5-azsous-projects.vercel.app';
const SHA = 'a'.repeat(40);
const DEP = '7387426331';
const DPL = 'dpl_5cZ2Upxoq7nxYxMXzet1RBuie72G';
const ENV = {
  I01_CONFIRM_ISOLATED: '1',
  I01_SUPABASE_URL: SB,
  I01_SUPABASE_ANON_KEY: ANON,
  I01_SITE_URL: STABLE,
  I01_CANDIDATE_SHA: SHA,
  I01_GITHUB_DEPLOYMENT_ID: DEP,
};
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4580000000049454e44ae426082',
  'hex',
);
const jwt = (p: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;

type MapO = { sha?: string; ready?: string; head?: string; dpl?: string; seqHead?: string[] };
/** 假管理面：GitHub Deployments + 分支头 + Vercel 别名 / 部署；seqHead 让第 n 次查询分支头返回不同值 */
function adminFake(o: MapO = {}) {
  const calls: string[] = [];
  let headN = 0;
  const host = new URL(STABLE).host;
  const t = async (u: string) => {
    calls.push(u);
    const url = new URL(u);
    const p = url.pathname;
    const j = (b: unknown, status = 200) => Response.json(b, { status });
    if (url.host === 'api.github.com') {
      if (p === `/repos/azsou/azsou-site/deployments/${DEP}`)
        return j({ id: Number(DEP), sha: SHA, environment: 'Preview', creator: { login: 'vercel[bot]' } });
      if (p === `/repos/azsou/azsou-site/deployments/${DEP}/statuses`)
        return j([
          {
            state: 'success',
            environment_url: `https://${UNIQUE_HOST}`,
            target_url: `https://vercel.com/azsous-projects/azsou-site/${(o.dpl ?? DPL).replace(/^dpl_/, '')}`,
            log_url: `https://${UNIQUE_HOST}`,
          },
        ]);
      if (p === '/repos/azsou/azsou-site/git/ref/heads/candidate/2026-10-27-integrated') {
        const head = o.seqHead ? o.seqHead[Math.min(headN++, o.seqHead.length - 1)] : (o.head ?? SHA);
        return j({ object: { sha: head } });
      }
    }
    if (url.host === 'api.vercel.com') {
      if (p === `/v4/aliases/${host}`) return j({ alias: host, deploymentId: o.dpl ?? DPL });
      if (p === `/v4/aliases/${UNIQUE_HOST}`) return j({ error: { code: 'not_found' } }, 404);
      if (p === `/v13/deployments/${o.dpl ?? DPL}` || p === `/v13/deployments/${UNIQUE_HOST}`)
        return j({
          id: o.dpl ?? DPL,
          url: UNIQUE_HOST,
          readyState: o.ready ?? 'READY',
          meta: { githubCommitSha: o.sha ?? SHA },
        });
    }
    return j({}, 404);
  };
  return { calls, t };
}

const GOOD: Record<string, Record<string, unknown>> = {
  'T046-1': {
    verify_redirect_origin: STABLE,
    verify_redirect_path: '/auth/callback/',
    session_established: true,
    replay_rejected: true,
  },
  'T046-2': {
    verify_redirect_origin: STABLE,
    new_password_login_ok: true,
    old_password_rejected: true,
    replay_rejected: true,
  },
  'T046-3': { landing_origins: [STABLE, STABLE, STABLE] },
  // 第八轮：过期原因必须明确是过期、同一 token 有效期内被接受（200）
  'T046-4': {
    user_status: 401,
    verify_session_issued: false,
    expired_user_status: 401,
    expired_reason_is_expiry: true,
    accepted_before_exp_status: 200,
  },
  'T046-5': {
    turnstile_real_key: true,
    register_api_status: 200,
    fake_token_status: 400,
    rate_limit_status: 429,
  },
  'T046-6': {
    final_origin: STABLE,
    final_path: '/forum/',
    code_replay_rejected: true,
    bad_state_rejected: true,
  },
  T074: {
    vectors_total: allVectors().length,
    vectors_executed: allVectors(),
    vectors_rejected_or_idempotent: allVectors().length,
    offsite_navigations: 0,
    vectors: allVectors().map((input) => ({
      input,
      landed_origin: STABLE,
      landed_path: (BENIGN_DOT_NEXT.find(([i]) => i === input) ?? [input, '/'])[1],
    })),
  },
};
const MAPREC = { domain: new URL(STABLE).host, vercel_deployment_id: DPL, sha: SHA };
function evidence(tweak?: (m: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r7-ev-'));
  const steps: Record<string, unknown> = {};
  for (const id of Object.keys(GOOD)) {
    const artifacts = Object.keys(R.MANUAL_CHECKLIST[id].artifacts).map((kind: string) => {
      const rel = `${id}-${kind}.png`;
      fs.writeFileSync(path.join(dir, rel), PNG);
      return { kind, path: rel, sha256: createHash('sha256').update(PNG).digest('hex') };
    });
    steps[id] = {
      result: 'pass',
      performed_at: new Date(Date.now() - 3600_000).toISOString(),
      artifacts,
      observations: structuredClone(GOOD[id]),
    };
  }
  const m = {
    project_ref: 'ovvfwkmqlejcpatmfqcd',
    site_origin: STABLE,
    candidate_sha: SHA,
    operator: '站长',
    deployment_mapping: { before: { ...MAPREC }, after: { ...MAPREC } },
    steps,
  };
  tweak?.(m);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}
/** 用户通道哨兵：任何请求都记下并抛错（证明没有发） */
const userSentinel = () => {
  const calls: string[] = [];
  return {
    calls,
    t: async (u: string) => {
      calls.push(u);
      throw new Error('USER_NETWORK_CALLED');
    },
  };
};
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
const runMain = async (args: string[], env: Record<string, string>, io: Record<string, unknown>) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r7-out-'));
  const code = await quiet(() => R.main(args, env, out, io));
  const f = path.join(out, 'report.json');
  return { code, report: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null };
};

describe('稳定候选域名：不硬拒，前后记录映射', () => {
  it('稳定域名（分支别名）+ 映射成立 + 全部人工证据 → 0；报告带前后映射', async () => {
    const a = adminFake();
    const u = userSentinel();
    const r = await runMain([`--manual-evidence=${evidence()}`], ENV, {
      adminTransport: a.t,
      userTransport: u.t,
    });
    expect(r.code).toBe(R.EXIT.PASS);
    expect(r.report.mapping.before).toMatchObject({
      domain: new URL(STABLE).host,
      vercel_deployment_id: DPL,
      sha: SHA,
    });
    expect(r.report.mapping.changed).toEqual([]);
    expect(u.calls).toHaveLength(0);
  });
  it('checkPreconditions 不再拒绝 *-git-* 稳定域名', () => {
    expect(R.checkPreconditions(ENV).ok).toBe(true);
  });
  it.each([
    ['分支头 ≠ 候选（验收前有人推送）', { head: 'b'.repeat(40) }, /分支/],
    ['稳定域名指向的部署不是候选 SHA', { sha: 'c'.repeat(40) }, /sha/],
    ['部署不是 READY', { ready: 'ERROR' }, /READY/],
  ])('%s → 2，一个用户请求都不发', async (_l, o, msg) => {
    const a = adminFake(o as MapO);
    const u = userSentinel();
    const errs: string[] = [];
    const e = console.error;
    console.error = (s: string) => errs.push(String(s));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r7-'));
    const code = await R.main([`--manual-evidence=${evidence()}`], ENV, out, {
      adminTransport: a.t,
      userTransport: u.t,
    });
    console.error = e;
    expect(code).toBe(R.EXIT.PRECONDITION);
    expect(errs.join('\n')).toMatch(msg);
    expect(u.calls).toHaveLength(0);
  });
  it('验收期间映射变化（分支头被推送）→ 证据作废，退出码 3（不是 0）', async () => {
    const a = adminFake({ seqHead: [SHA, 'd'.repeat(40)] });
    const r = await runMain([`--manual-evidence=${evidence()}`], ENV, {
      adminTransport: a.t,
      userTransport: userSentinel().t,
    });
    expect(r.code).toBe(R.EXIT.INCOMPLETE);
    expect(r.report.summary.invalidated.join()).toMatch(/branch_head/);
  });
  it.each([
    ['人工证据缺 deployment_mapping', (m: any) => delete m.deployment_mapping],
    [
      '人工证据记录的部署 id 与脚本不同',
      (m: any) => (m.deployment_mapping.after.vercel_deployment_id = 'dpl_Other'),
    ],
  ])('%s → 1', async (_l, tw) => {
    const r = await runMain([`--manual-evidence=${evidence(tw)}`], ENV, {
      adminTransport: adminFake().t,
      userTransport: userSentinel().t,
    });
    expect(r.code).toBe(R.EXIT.FAIL);
  });
});

describe('T074：42 个向量逐条期望 vs 实际', () => {
  it('全表 42 条 = 39 个外域向量 + 3 条合法点段', () => {
    expect(allVectors()).toHaveLength(42);
    expect(EVIL_NEXT).toHaveLength(39);
    for (const [i, out] of BENIGN_DOT_NEXT) expect(R.expectedLanding(i)).toBe(out);
    for (const i of EVIL_NEXT) expect(R.expectedLanding(i)).toBe('/');
  });
  it('vectorProblems：全对 → 无问题；合法路径落到 / → 问题；外域 → 问题；缺 / 重复 → 问题', () => {
    const good = GOOD.T074.vectors as { input: string; landed_origin: string; landed_path: string }[];
    expect(R.vectorProblems(good, STABLE)).toEqual([]);
    const benignWrong = good.map((x) => (x.input === BENIGN_DOT_NEXT[2][0] ? { ...x, landed_path: '/' } : x));
    expect(R.vectorProblems(benignWrong, STABLE).join()).toMatch(/期望 \/forum\/new\/\?cat=tech/);
    const off = good.map((x, i) => (i === 0 ? { ...x, landed_origin: 'https://evil.example' } : x));
    expect(R.vectorProblems(off, STABLE).join()).toMatch(/外站/);
    expect(R.vectorProblems(good.slice(1), STABLE).join()).toMatch(/缺向量/);
    expect(R.vectorProblems([...good, good[3]], STABLE).join()).toMatch(/重复/);
  });
  it('报告里 T074 有 42 行期望 / 实际；一条合法路径落错 → 1', async () => {
    const ok = await runMain([`--manual-evidence=${evidence()}`], ENV, {
      adminTransport: adminFake().t,
      userTransport: userSentinel().t,
    });
    const t074 = ok.report.results.find((x: { id: string }) => x.id === 'T074');
    expect(t074.vectors).toHaveLength(42);
    expect(t074.vectors.every((v: { ok: boolean }) => v.ok)).toBe(true);
    expect(t074.vectors.find((v: { input: string }) => v.input === '/a/../forum/').expected).toBe(
      `${STABLE}/forum/`,
    );
    const bad = await runMain(
      [
        `--manual-evidence=${evidence((m) => {
          m.steps.T074.observations.vectors.find((v: any) => v.input === '/./articles/').landed_path = '/';
        })}`,
      ],
      ENV,
      { adminTransport: adminFake().t, userTransport: userSentinel().t },
    );
    expect(bad.code).toBe(R.EXIT.FAIL);
  });
});

describe('用户验收通道与管理通道隔离', () => {
  const user = (t: (u: string, i: any) => Promise<Response>, canary = false) =>
    CH.userChannel({ sbOrigin: SB, siteOrigin: STABLE, anonKey: ANON, transport: t, canary });
  const ok = async () => new Response('{}', { status: 200 });
  it('用户通道只允许测试项目 / 预览站 / 收件箱；拒绝 GitHub / Vercel / 外站', async () => {
    expect(typeof CH.userChannel).toBe('function');
    const u = user(ok);
    await expect(u('https://api.github.com/x')).rejects.toThrow(CH.ChannelViolation);
    await expect(u('https://api.vercel.com/x')).rejects.toThrow(CH.ChannelViolation);
    await expect(u('https://evil.example/')).rejects.toThrow(CH.ChannelViolation);
    expect((await u(`${SB}/auth/v1/user`, { headers: { apikey: ANON } })).status).toBe(200);
  });
  it('用户通道拒绝 service_role JWT、sb_secret_ 与非 anon 的 apikey', async () => {
    const u = user(ok);
    const svc = jwt({ role: 'service_role', iss: 'supabase' });
    await expect(
      u(`${SB}/rest/v1/x`, { headers: { apikey: ANON, authorization: `Bearer ${svc}` } }),
    ).rejects.toThrow(/service_role/);
    await expect(u(`${SB}/rest/v1/x`, { headers: { apikey: 'sb_secret_x' } })).rejects.toThrow(/sb_secret_/);
    await expect(u(`${SB}/rest/v1/x`, { headers: { apikey: 'other' } })).rejects.toThrow(/anon/);
    const usr = jwt({ role: 'authenticated', sub: 'u1' });
    expect(
      (await u(`${SB}/rest/v1/x`, { headers: { apikey: ANON, authorization: `Bearer ${usr}` } })).status,
    ).toBe(200);
  });
  it('金丝雀：只带 anon 读 Auth Admin 得到 200 = 被注入 → ChannelPolluted，原请求不发；401 → 继续', async () => {
    const sent: string[] = [];
    const injected = async (u: string) => {
      sent.push(u);
      return new Response('{"users":[]}', { status: u.includes('/admin/users') ? 200 : 200 });
    };
    const u = user(injected, true);
    await expect(u(`${SB}/auth/v1/user`, { headers: { apikey: ANON } })).rejects.toThrow(CH.ChannelPolluted);
    expect(sent).toEqual([`${SB}/auth/v1/admin/users?per_page=1`]);
    const clean = user(
      async (x: string) => new Response('{}', { status: x.includes('/admin/users') ? 401 : 200 }),
      true,
    );
    expect((await clean(`${SB}/auth/v1/user`, { headers: { apikey: ANON } })).status).toBe(200);
  });
  it('用户通道默认直连：不经全局 fetch（即使它会注入），也不读 *_PROXY；服务器只看到我们发的头', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(req.url?.includes('/admin/users') ? 401 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const origFetch = globalThis.fetch;
    const origProxy = process.env.HTTP_PROXY;
    let globalCalls = 0;
    globalThis.fetch = (async () => {
      globalCalls++;
      return new Response('{"users":[]}', { status: 200 }); // 模拟出口代理注入 service_role
    }) as typeof fetch;
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    try {
      const u = CH.userChannel({ sbOrigin: origin, siteOrigin: STABLE, anonKey: ANON });
      const r = await u(`${origin}/auth/v1/user`, { headers: { apikey: ANON } });
      expect(r.status).toBe(200);
      expect(globalCalls).toBe(0);
      expect(seen).toHaveLength(2); // 金丝雀 + 请求
      for (const h of seen) {
        expect(h.apikey).toBe(ANON);
        expect(h.authorization).toBeUndefined();
      }
    } finally {
      globalThis.fetch = origFetch;
      if (origProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = origProxy;
      srv.close();
    }
  });
  it('管理通道只允许 GitHub / Vercel 的只读 GET', async () => {
    const a = CH.adminChannel({ transport: ok, forbidOrigins: [SB, STABLE] });
    await expect(a(`${SB}/auth/v1/admin/users`)).rejects.toThrow(CH.ChannelViolation);
    await expect(a(`${STABLE}/`)).rejects.toThrow(CH.ChannelViolation);
    await expect(a('https://api.github.com/x', { method: 'POST' })).rejects.toThrow(/只读/);
    expect((await a('https://api.github.com/x')).status).toBe(200);
  });
  it('main：用户通道金丝雀发现注入 → 自动用例全部阻塞（不是通过），后续不再发用户请求', async () => {
    const sent: string[] = [];
    const injected = async (u: string) => {
      sent.push(u);
      return new Response('{"users":[]}', { status: 200 });
    };
    const r = await runMain([`--manual-evidence=${evidence((m) => delete m.steps['T046-4'])}`], ENV, {
      adminTransport: adminFake().t,
      userTransport: injected,
    });
    expect(r.code).toBe(R.EXIT.INCOMPLETE);
    expect(r.report.summary.blocked).toContain('T046-4');
    expect(r.report.summary.channel).toMatch(/用户通道不干净/);
    expect(sent).toEqual([`${SB}/auth/v1/admin/users?per_page=1`]);
  });
});

describe('T046-4 真实过期 token；T046-2 重置后旧 / 新密码（实现了，真实环境未执行）', () => {
  const cfg = (o: Record<string, unknown> = {}) => ({
    SB,
    SITE: STABLE,
    siteOrigin: STABLE,
    inbox: true,
    expiredTokenFile: '/x/expired.jwt',
    expiredTokenRecordFile: '/x/expired.accepted.json',
    ...o,
  });
  const env = {
    ...ENV,
    I01_INBOX_API: 'https://inbox.example/api',
    I01_INBOX_TOKEN: 't',
    I01_INBOX_DOMAIN: 'inbox.example',
  };
  const expired = jwt({
    iss: `${SB}/auth/v1`,
    role: 'authenticated',
    sub: 'u',
    exp: Math.floor(Date.now() / 1000) - 7200,
  });
  const fake = (o: { userStatus?: number; oldLogin?: number; body?: string } = {}) => {
    const log: string[] = [];
    let pw = 'OLD';
    let verified = 0;
    const t = async (u: string, init: any = {}) => {
      const url = new URL(u);
      log.push(`${init.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/auth/v1/user' && (init.method ?? 'GET') === 'GET') {
        const tok = String(init.headers.authorization ?? '').replace('Bearer ', '');
        if (tok === expired)
          return new Response(
            o.body ?? '{"code":401,"error_code":"bad_jwt","msg":"invalid JWT: token is expired"}',
            {
              status: o.userStatus ?? 401,
            },
          );
        return new Response('{"msg":"invalid JWT"}', { status: 401 });
      }
      if (url.pathname === '/auth/v1/verify')
        return new Response(null, {
          status: 303,
          headers: {
            location:
              url.searchParams.get('token')?.startsWith('000000') || verified++ > 0
                ? `${STABLE}/auth/callback/#error=access_denied`
                : `${STABLE}/auth/callback/#access_token=${jwt({ role: 'authenticated', sub: 'u' })}&type=recovery`,
          },
        });
      if (url.pathname === '/auth/v1/recover') return new Response('{}', { status: 200 });
      if (url.pathname === '/auth/v1/user' && init.method === 'PUT') {
        pw = JSON.parse(init.body).password;
        return new Response('{}', { status: 200 });
      }
      if (url.pathname === '/auth/v1/token') {
        const b = JSON.parse(init.body);
        if (b.password === pw) return new Response('{"access_token":"x"}', { status: 200 });
        return new Response('{"error_code":"invalid_credentials"}', { status: o.oldLogin ?? 400 });
      }
      if (url.host === 'inbox.example' && url.pathname.endsWith('/search'))
        return Response.json({ messages: [{ ID: 'm1' }] });
      if (url.host === 'inbox.example')
        return Response.json({
          Text: `${SB}/auth/v1/verify?token=abc&type=recovery&redirect_to=${STABLE}/auth/callback/`,
        });
      return new Response('?', { status: 404 });
    };
    return { log, t };
  };
  const steps = (f: ReturnType<typeof fake>, c = cfg(), io: Record<string, unknown> = {}) => {
    const u = CH.userChannel({
      sbOrigin: SB,
      siteOrigin: STABLE,
      inboxOrigin: 'https://inbox.example',
      anonKey: ANON,
      transport: f.t,
      canary: false,
    });
    // 第八轮：有效期内被接受的记录（同一 token 的 sha256、同一 sub、早于 exp、200）
    const rec = {
      token_sha256: createHash('sha256').update(expired).digest('hex'),
      project_ref: 'ovvfwkmqlejcpatmfqcd',
      iss: `${SB}/auth/v1`,
      sub: 'u',
      exp: CH.jwtPayload(expired).exp,
      accepted_status: 200,
      accepted_user_id: 'u',
      accepted_at: new Date((CH.jwtPayload(expired).exp - 600) * 1000).toISOString(),
    };
    return R.automatedSteps(env, c, u, {
      readFile: (p: string) => (String(p).endsWith('.json') ? JSON.stringify(rec) : expired),
      exists: () => true,
      stat: () => ({ mode: 0o100600 }),
      now: () => Date.now(),
      ...io,
    });
  };
  const notes: string[] = [];
  it('T046-4：伪造 + 真实过期 token 都被拒（401 且原因是过期）+ 有效期内被接受记录 → 通过', async () => {
    const f = fake();
    await steps(f)['T046-4']((m: string) => notes.push(m));
    expect(f.log).toContain('GET /auth/v1/user');
  });
  it.each([
    ['过期 token 竟然被接受', { userStatus: 200 }, {}, cfg(), /没有被拒/],
    ['被拒但不是因为过期', { body: '{"msg":"invalid signature"}' }, {}, cfg(), /不是「过期」/],
    [
      'token 还没过期',
      {},
      { readFile: () => jwt({ iss: `${SB}/auth/v1`, role: 'authenticated', exp: 9e9 }) },
      cfg(),
      /还没过期/,
    ],
    [
      '不是 azsou-test 签发',
      {},
      { readFile: () => jwt({ iss: 'https://x/auth/v1', role: 'authenticated', exp: 1 }) },
      cfg(),
      /azsou-test/,
    ],
    ['token 文件权限太宽', {}, { stat: () => ({ mode: 0o100644 }) }, cfg(), /0600/],
  ])('T046-4：%s → 失败', async (_l, fo, io, c, msg) => {
    await expect(steps(fake(fo as any), c, io as any)['T046-4'](() => {})).rejects.toThrow(msg);
  });
  it('T046-4：没有过期 token 文件 → 阻塞（不是通过）', async () => {
    await expect(steps(fake(), cfg({ expiredTokenFile: '' }))['T046-4'](() => {})).rejects.toMatchObject({
      blocked: true,
    });
  });
  it('T046-2：recovery → 设新密码 → 旧密码 400、新密码 200 → 通过；旧密码仍能登录 → 失败', async () => {
    const f = fake();
    await steps(f)['T046-2'](() => {});
    expect(f.log).toContain('PUT /auth/v1/user');
    expect(f.log.filter((x) => x === 'POST /auth/v1/token')).toHaveLength(2);
    await expect(steps(fake({ oldLogin: 200 }))['T046-2'](() => {})).rejects.toThrow(/旧密码仍可登录/);
  });
});
