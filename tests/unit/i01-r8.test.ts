/**
 * I01 第八轮（站长 2026-10-29 round 8，I01）回归：先在当前代码上写失败用例，再修。全部离线。
 *  - T046-4：/expired|bad_jwt/ 会把「签名错误」的 bad_jwt 当成过期。改为必须有**真实过期证据**：
 *    拒绝正文的原因明确是过期（不是签名错误 / 解析错误），且 exp < now；token 来自真实来源，且在有效期内被接受过
 *    （capture-token 记录：token sha256、azsou-test /auth/v1/user 200、accepted_at < exp、同一 sub）。
 *  - 用户直连通道不可用 → 整个验收停止（阻塞），绝不回退到管理 / 注入代理。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as RA from '../../scripts/i01/real-acceptance.mjs';
import * as CHM from '../../scripts/i01/channels.mjs';

vi.setConfig({ testTimeout: 30_000 });

const R = RA as any;
const CH = CHM as any;
const SB = 'https://ovvfwkmqlejcpatmfqcd.supabase.co';
const ANON = 'sb_publishable_test';
const STABLE = 'https://azsou-site-git-candidate-2026-10-27-integrated-azsous-projects.vercel.app';
const jwt = (p: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NOW = Date.now();
const EXP = Math.floor(NOW / 1000) - 7200;
const SUB = '11111111-2222-3333-4444-555555555555';
const expired = jwt({ iss: `${SB}/auth/v1`, role: 'authenticated', sub: SUB, exp: EXP, iat: EXP - 3600 });
/** GoTrue 对过期 token 的真实回答（v2.x：bad_jwt + "token is expired"） */
const EXPIRED_BODY =
  '{"code":401,"error_code":"bad_jwt","msg":"invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired"}';
/** GoTrue 对错签名 token 的真实回答：同样是 bad_jwt，但原因是签名 */
const BADSIG_BODY =
  '{"code":401,"error_code":"bad_jwt","msg":"invalid JWT: unable to parse or verify signature, token signature is invalid: signature is invalid"}';
const goodRecord = (o: Record<string, unknown> = {}) => ({
  token_sha256: sha(expired),
  project_ref: 'ovvfwkmqlejcpatmfqcd',
  iss: `${SB}/auth/v1`,
  sub: SUB,
  exp: EXP,
  accepted_status: 200,
  accepted_user_id: SUB,
  accepted_at: new Date((EXP - 1800) * 1000).toISOString(),
  captured_by: 'scripts/i01/real-acceptance.mjs --capture-token',
  ...o,
});
const cfg = (o: Record<string, unknown> = {}) => ({
  SB,
  SITE: STABLE,
  siteOrigin: STABLE,
  inbox: false,
  expiredTokenFile: '/x/expired.jwt',
  expiredTokenRecordFile: '/x/expired.accepted.json',
  ...o,
});
const fakeUser = (body = EXPIRED_BODY, status = 401) => {
  const log: string[] = [];
  const t = async (u: string, init: any = {}) => {
    const url = new URL(u);
    log.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/auth/v1/user') {
      const tok = String(init.headers?.authorization ?? '').replace('Bearer ', '');
      if (tok === expired) return new Response(body, { status });
      return new Response('{"code":401,"error_code":"bad_jwt","msg":"invalid JWT: token is malformed"}', {
        status: 401,
      });
    }
    if (url.pathname === '/auth/v1/verify')
      return new Response(null, {
        status: 303,
        headers: { location: `${STABLE}/auth/callback/#error=access_denied` },
      });
    return new Response('?', { status: 404 });
  };
  return { log, t };
};
const steps = (
  f: ReturnType<typeof fakeUser>,
  c = cfg(),
  rec: unknown = goodRecord(),
  io: Record<string, unknown> = {},
) => {
  const u = CH.userChannel({
    sbOrigin: SB,
    siteOrigin: STABLE,
    anonKey: ANON,
    transport: f.t,
    canary: false,
  });
  return R.automatedSteps({ I01_SUPABASE_ANON_KEY: ANON }, c, u, {
    readFile: (p: string) => (String(p).endsWith('.json') ? JSON.stringify(rec) : expired),
    exists: () => rec !== undefined,
    stat: () => ({ mode: 0o100600 }),
    now: () => NOW,
    ...io,
  });
};

describe('第八轮 I01 T046-4：必须有真实过期证据', () => {
  it('错签名的 bad_jwt（不是过期）→ 不能算过期，失败', async () => {
    await expect(steps(fakeUser(BADSIG_BODY))['T046-4'](() => {})).rejects.toThrow(/不是「过期」/);
  });
  it('只有 error_code bad_jwt、没有过期原因 → 失败', async () => {
    await expect(steps(fakeUser('{"code":401,"error_code":"bad_jwt"}'))['T046-4'](() => {})).rejects.toThrow(
      /不是「过期」/,
    );
  });
  it('正文同时含「expired」和签名错误 → 失败（签名错误优先）', async () => {
    await expect(
      steps(fakeUser('{"error_code":"bad_jwt","msg":"signature is invalid; token is expired"}'))['T046-4'](
        () => {},
      ),
    ).rejects.toThrow(/不是「过期」/);
  });
  it('没有「有效期内被接受」的记录 → 阻塞（不是通过）', async () => {
    await expect(
      steps(fakeUser(), cfg({ expiredTokenRecordFile: '' }))['T046-4'](() => {}),
    ).rejects.toMatchObject({
      blocked: true,
    });
  });
  it.each([
    ['记录里的 token sha256 对不上', { token_sha256: 'f'.repeat(64) }, /sha256/],
    ['记录里有效期内的状态不是 200', { accepted_status: 401 }, /200/],
    [
      '被接受的时间晚于 exp（不是有效期内）',
      { accepted_at: new Date((EXP + 10) * 1000).toISOString() },
      /有效期内/,
    ],
    ['被接受的用户不是 token 的 sub', { accepted_user_id: 'someone-else' }, /sub/],
    ['记录不是 azsou-test', { project_ref: 'abryflgoljltyakthtql' }, /azsou-test/],
  ])('%s → 失败', async (_l, o, msg) => {
    await expect(steps(fakeUser(), cfg(), goodRecord(o))['T046-4'](() => {})).rejects.toThrow(msg);
  });
  it('记录文件权限太宽 → 失败', async () => {
    await expect(
      steps(fakeUser(), cfg(), goodRecord(), {
        stat: (p: string) => ({ mode: String(p).endsWith('.json') ? 0o100644 : 0o100600 }),
      })['T046-4'](() => {}),
    ).rejects.toThrow(/0600/);
  });
  it('真实来源 + 有效期内被接受 + 过期后被拒且原因是过期 + exp < now → 通过；备注写明三段证据', async () => {
    const notes: string[] = [];
    await steps(fakeUser())['T046-4']((m: string) => notes.push(m));
    expect(notes.join('\n')).toMatch(/有效期内.*200/);
    expect(notes.join('\n')).toMatch(/过期/);
  });
  it('isExpiryRejection：GoTrue 过期正文 → true；错签名 / 只有 bad_jwt / 畸形 → false', () => {
    expect(R.isExpiryRejection(EXPIRED_BODY)).toBe(true);
    expect(R.isExpiryRejection('{"msg":"JWT expired"}')).toBe(true);
    for (const b of [
      BADSIG_BODY,
      '{"error_code":"bad_jwt"}',
      '{"msg":"invalid JWT: token is malformed"}',
      'expired?',
      '',
    ])
      expect(R.isExpiryRejection(b)).toBe(false);
  });
});

describe('第八轮 I01 capture-token：有效期内被接受的记录（实现了，真实环境未执行）', () => {
  const valid = jwt({
    iss: `${SB}/auth/v1`,
    role: 'authenticated',
    sub: SUB,
    exp: Math.floor(NOW / 1000) + 600,
  });
  const mk = (status: number, body: unknown) => {
    const t = async () => new Response(JSON.stringify(body), { status });
    return CH.userChannel({ sbOrigin: SB, siteOrigin: STABLE, anonKey: ANON, transport: t, canary: false });
  };
  it('azsou-test /auth/v1/user 200 且 id = sub、未过期 → 写 0600 记录（token 只存 sha256）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r8-cap-'));
    const out = path.join(dir, 'rec.json');
    const rec = await R.captureAcceptedToken(valid, { SB, out, user: mk(200, { id: SUB }), now: () => NOW });
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(j).toMatchObject({
      token_sha256: sha(valid),
      accepted_status: 200,
      accepted_user_id: SUB,
      sub: SUB,
    });
    expect(fs.readFileSync(out, 'utf8')).not.toContain(valid);
    expect(rec.accepted_status).toBe(200);
  });
  it('401 / id ≠ sub / 已过期 / 不是 azsou-test 签发 → 拒绝，不写记录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r8-cap2-'));
    const out = path.join(dir, 'rec.json');
    await expect(
      R.captureAcceptedToken(valid, { SB, out, user: mk(401, {}), now: () => NOW }),
    ).rejects.toThrow();
    await expect(
      R.captureAcceptedToken(valid, { SB, out, user: mk(200, { id: 'x' }), now: () => NOW }),
    ).rejects.toThrow(/sub/);
    await expect(
      R.captureAcceptedToken(expired, { SB, out, user: mk(200, { id: SUB }), now: () => NOW }),
    ).rejects.toThrow(/过期/);
    const other = jwt({
      iss: 'https://x/auth/v1',
      role: 'authenticated',
      sub: SUB,
      exp: Math.floor(NOW / 1000) + 600,
    });
    await expect(
      R.captureAcceptedToken(other, { SB, out, user: mk(200, { id: SUB }), now: () => NOW }),
    ).rejects.toThrow(/azsou-test/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('第八轮 I01 用户直连通道不可用 → 停止，绝不回退到管理 / 注入代理', () => {
  it('userChannel：直连网络错误 → ChannelUnavailable', async () => {
    expect(typeof CH.ChannelUnavailable).toBe('function');
    const t = async () => {
      throw Object.assign(new TypeError('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
    };
    const u = CH.userChannel({
      sbOrigin: SB,
      siteOrigin: STABLE,
      anonKey: ANON,
      transport: t,
      canary: false,
    });
    await expect(u(`${SB}/auth/v1/user`, { headers: { apikey: ANON } })).rejects.toThrow(
      CH.ChannelUnavailable,
    );
  });
  it('main：用户直连不可用 → 自动用例全部阻塞、summary.channel 写明，管理通道从未被用来访问测试项目 / 预览站', async () => {
    const adminCalls: string[] = [];
    const DEP = '7387426331';
    const DPL = 'dpl_5cZ2Upxoq7nxYxMXzet1RBuie72G';
    const SHA = 'a'.repeat(40);
    const UNIQUE = 'azsou-site-kd7wqy8m5-azsous-projects.vercel.app';
    const admin = async (u: string) => {
      adminCalls.push(u);
      const url = new URL(u);
      const p = url.pathname;
      const j = (b: unknown, status = 200) => Response.json(b, { status });
      if (p === `/repos/azsou/azsou-site/deployments/${DEP}`)
        return j({ id: Number(DEP), sha: SHA, environment: 'Preview', creator: { login: 'vercel[bot]' } });
      if (p === `/repos/azsou/azsou-site/deployments/${DEP}/statuses`)
        return j([
          {
            state: 'success',
            environment_url: `https://${UNIQUE}`,
            target_url: `https://vercel.com/azsous-projects/azsou-site/${DPL.replace(/^dpl_/, '')}`,
            log_url: `https://${UNIQUE}`,
          },
        ]);
      if (p.startsWith('/repos/azsou/azsou-site/git/ref/heads/')) return j({ object: { sha: SHA } });
      if (p === `/v4/aliases/${new URL(STABLE).host}`)
        return j({ alias: new URL(STABLE).host, deploymentId: DPL });
      if (p.startsWith('/v13/deployments/'))
        return j({ id: DPL, url: UNIQUE, readyState: 'READY', meta: { githubCommitSha: SHA } });
      return j({}, 404);
    };
    const userCalls: string[] = [];
    const down = async (u: string) => {
      userCalls.push(u);
      throw Object.assign(new TypeError('getaddrinfo EAI_AGAIN ovvfwkmqlejcpatmfqcd.supabase.co'), {
        code: 'EAI_AGAIN',
      });
    };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'i01r8-out-'));
    const [l, e] = [console.log, console.error];
    console.log = () => {};
    console.error = () => {};
    let code;
    try {
      code = await R.main(
        ['--only=T046-4'],
        {
          I01_CONFIRM_ISOLATED: '1',
          I01_SUPABASE_URL: SB,
          I01_SUPABASE_ANON_KEY: ANON,
          I01_SITE_URL: STABLE,
          I01_CANDIDATE_SHA: SHA,
          I01_GITHUB_DEPLOYMENT_ID: DEP,
        },
        out,
        { adminTransport: admin, userTransport: down },
      );
    } finally {
      console.log = l;
      console.error = e;
    }
    const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    expect(code).not.toBe(R.EXIT.PASS);
    expect(rep.summary.blocked).toContain('T046-4');
    expect(rep.summary.failed).not.toContain('T046-4');
    expect(rep.summary.channel).toMatch(/直连.*不可用/);
    expect(userCalls).toHaveLength(1); // 不重试、不换通道
    expect(adminCalls.some((u) => u.startsWith(SB) || u.startsWith(STABLE))).toBe(false);
  });
});

describe('第八轮 I01 人工证据清单：T046-4 需要真实过期证据', () => {
  it('MANUAL_CHECKLIST T046-4：过期原因必须是过期、必须有「有效期内被接受」的观测', () => {
    const t = R.MANUAL_CHECKLIST['T046-4'];
    expect(Object.keys(t.artifacts)).toContain('expired-token-lifecycle');
    expect(t.observations.expired_reason_is_expiry(true)).toBe(true);
    expect(t.observations.expired_reason_is_expiry('bad_jwt')).toBe(false);
    expect(t.observations.accepted_before_exp_status(200)).toBe(true);
    expect(t.observations.accepted_before_exp_status(401)).toBe(false);
  });
  it('manual-evidence.md 写明错签名 bad_jwt 不算过期', () => {
    const md = fs.readFileSync('docs/audits/evidence/batch1/i01/manual-evidence.md', 'utf8');
    expect(md).toMatch(/expired_reason_is_expiry/);
    expect(md).toMatch(/签名.*不算过期|不算过期.*签名/);
  });
});
