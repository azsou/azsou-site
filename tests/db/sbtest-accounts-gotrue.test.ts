/**
 * 第七轮 ④：azsou-test 初始化执行器的「无邮件」账号路径，在本机官方 GoTrue（Supabase Auth 发布的二进制，tests/db/gotrue.ts）上证明。
 * 用的是执行器自己的代码（client / admitProjectService / createUsers / fileHandoff / adminSetPassword），不是另写一份：
 *  - 项目服务准入：service_role → 200 + {users:[…]}；anon / 无凭据 → 不接受；
 *  - 建号：email_confirm: true + 运行标记 + 强密码，GoTrue 不发确认信（MAILER_AUTOCONFIRM 关、也没配 SMTP），邮箱已确认，只有 email 身份；
 *  - 交接文件（仓库外 0600）里的密码能直接 grant_type=password 登录；
 *  - 接管时 Admin PUT 改密：旧密码 400，新密码 200。
 * 托管 Supabase 前面多一层 Kong（/auth/v1 前缀 + apikey）；这里把 /auth/v1/ 去掉直连 GoTrue，其余请求与真实执行一致。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as X from '../../scripts/sbtest/init-executor.mjs';
import { gotrueBinary, prepareAuthDb, signJwt, startGotrue, type Gotrue } from './gotrue';

const E = X as any;
const DB = 'sbtest_gotrue_r7';
const PORT = 49_871;
let gt: Gotrue;

const jwt = (role: string) =>
  signJwt({
    role,
    iss: 'supabase',
    aud: role === 'anon' ? 'anon' : undefined,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
/** Kong 的 /auth/v1 前缀在本机没有：去掉后直连 GoTrue */
const viaKong = ((url: string, init?: RequestInit) =>
  fetch(String(url).replace('/auth/v1/', '/'), init)) as typeof fetch;
const mkClient = (serviceKey: string) =>
  E.client({
    mode: 'env-token',
    token: 'unused-management-token',
    serviceKey,
    mgmtBase: 'http://127.0.0.1:9',
    projectBase: gt.url,
    fetchImpl: viaKong,
  });
const login = (email: string, password: string) =>
  fetch(`${gt.url}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
const adminGet = async (id: string) =>
  (
    await fetch(`${gt.url}/admin/users/${id}`, {
      headers: { authorization: `Bearer ${jwt('service_role')}` },
    })
  ).json();

beforeAll(async () => {
  const bin = gotrueBinary();
  await prepareAuthDb(DB, bin);
  gt = await startGotrue(bin, DB, PORT, { autoconfirm: false });
});
afterAll(async () => {
  await gt?.stop();
});

describe('第七轮 ① 项目服务准入（真实 GoTrue）', () => {
  it('service_role → 200 且 {users:[…]} → 接受', async () => {
    const r = await E.admitProjectService(mkClient(jwt('service_role')));
    expect(r.accepted).toBe(true);
    expect(r.users_returned).toBe(0);
  });
  it('anon JWT → 不接受；无效签名 → 不接受', async () => {
    await expect(E.admitProjectService(mkClient(jwt('anon')))).rejects.toThrow(/不接受/);
    await expect(
      E.admitProjectService(
        mkClient(signJwt({ role: 'service_role' }, 'wrong-secret-0000000000000000000000000')),
      ),
    ).rejects.toThrow(/不接受/);
  });
});

describe('第七轮 ④ 无邮件建号 + 交接 + 改密（真实 GoTrue）', () => {
  it('建 4 个账号 → 交接文件 0600、密码可登录、邮箱已确认、未发信、运行标记在 app_metadata、只有 email 身份；改密后旧 400 新 200', async () => {
    const c = mkClient(jwt('service_role'));
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'r7-gotrue-')), 'h', 'accounts.jsonl');
    const handoff = E.fileHandoff(file, { attemptId: '20261029T000000-r7r7r7' });
    const results: { file: string; outcome: string }[] = [];
    const u = await E.createUsers(c, E.SYNTHETIC_USERS, handoff, results, 'r7-gotrue');
    expect(u.outcome).toBe('ok');
    expect(results.map((r) => r.outcome)).toEqual(['created', 'created', 'created', 'created']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l.password.length).toBeGreaterThanOrEqual(24);
      const r = await login(l.email, l.password);
      expect(r.status, `${l.email} 用交接密码登录`).toBe(200);
      expect((await r.json()).access_token).toBeTruthy();
      const a = await adminGet(l.user_id);
      expect(a.email_confirmed_at, '邮箱已确认（email_confirm: true）').toBeTruthy();
      expect(a.confirmation_sent_at ?? null, '没有发确认信').toBeNull();
      expect(a.app_metadata.az_init_run).toBe('r7-gotrue');
      expect(a.user_metadata.name).toBe(E.SYNTHETIC_USERS.find((x: any) => x.email === l.email).name);
      expect(a.identities.map((i: { provider: string }) => i.provider)).toEqual(['email']);
    }
    // 接管时的改密（Admin PUT，执行器 adminSetPassword）：旧密码失效、新密码可用，全程不发信
    const target = lines[0];
    const np = E.genPassword();
    const r = await c.adminSetPassword(target.user_id, np);
    expect(r.status).toBe(200);
    expect((await login(target.email, target.password)).status, '旧密码').toBe(400);
    expect((await login(target.email, np)).status, '新密码').toBe(200);
    expect((await adminGet(target.user_id)).recovery_sent_at ?? null, '没有发重置信').toBeNull();
  });
});

/**
 * 第八轮 B2 安全交接演示（**假密码 / 本机 GoTrue**，不连任何云项目、不往 vault 存任何东西）：
 *  1. 执行器同一段代码建 4 个账号 → 仓库外交接文件（目录 0700 / 文件 0600 / 属主 = 当前用户；每行 run_id + attempt_id）；
 *  2. 「Hark 读取并存进 vault」这一步：在沙箱里读 0600 文件，对每一行调用一次 save_login（这里用记录参数形状的桩代替，
 *     **不调用真实 vault**），全程不打印密码；
 *  3. 存完才粉碎文件（覆盖 + fsync + 删除）——0600 文件写好 ≠ 交接完成；
 *  4. 证明：交接密码能登录（grant_type=password）、日志 / 演示记录里没有任何密码。
 * SBTEST_DEMO_OUT=<路径> 时把打码后的演示记录写到该路径（只含邮箱、权限、属主、run_id / attempt_id、桩调用的形状）。
 */
describe('第八轮 B2 安全交接演示（假密码，本机 GoTrue）', () => {
  it('交接文件生成 → 权限核对 → Hark 读文件逐条 save_login（桩）→ 粉碎文件；密码不出现在任何输出', async () => {
    const c = mkClient(jwt('service_role'));
    const base = mkdtempSync(path.join(os.tmpdir(), 'r8-demo-'));
    const file = path.join(base, '.azsou-sbtest', '2026-10-29-accounts.jsonl');
    const attemptId = E.newAttemptId();
    const runId = attemptId; // 全新执行：run_id = attempt_id；续跑时 run_id 是账本里的旧值
    const handoff = E.fileHandoff(file, { attemptId });
    const results: { file: string; outcome: string }[] = [];
    // 演示前清掉上一个用例建的同名账号（本机临时库）
    for (const usr of (
      await (
        await fetch(`${gt.url}/admin/users`, { headers: { authorization: `Bearer ${jwt('service_role')}` } })
      ).json()
    ).users ?? [])
      await fetch(`${gt.url}/admin/users/${usr.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt('service_role')}` },
      });
    const u = await E.createUsers(c, E.SYNTHETIC_USERS, handoff, results, runId, attemptId);
    expect(u.outcome).toBe('ok');
    const dirSt = statSync(path.dirname(handoff.path));
    const fileSt = statSync(handoff.path);
    expect(dirSt.mode & 0o777).toBe(0o700);
    expect(fileSt.mode & 0o777).toBe(0o600);
    expect(fileSt.uid).toBe(process.getuid?.());
    // —— Hark 端：读 0600 文件，逐条存进 vault（桩：只记录调用形状；真实调用见 ops/SBTEST-INIT.md §10）
    const lines = readFileSync(handoff.path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    const saveLoginCalls: { site: string; username: string; password_len: number }[] = [];
    const saveLoginStub = (a: { site: string; username: string; password: string }) =>
      saveLoginCalls.push({ site: a.site, username: a.username, password_len: a.password.length });
    for (const l of lines) {
      expect(l.run_id).toBe(runId);
      expect(l.attempt_id).toBe(attemptId);
      expect(l.project_ref).toBe(E.TEST_REF);
      const r = await login(l.email, l.password);
      expect(r.status, `${l.email} 交接密码可登录`).toBe(200);
      saveLoginStub({ site: `${E.TEST_REF}.supabase.co`, username: l.email, password: l.password });
    }
    // —— 全部存完才粉碎：覆盖同长度随机字节 + fsync + 删除
    const size = statSync(handoff.path).size;
    const fd = openSync(handoff.path, 'r+');
    writeSync(
      fd,
      E.genPassword()
        .repeat(Math.ceil(size / 24))
        .slice(0, size),
    );
    fsyncSync(fd);
    closeSync(fd);
    unlinkSync(handoff.path);
    expect(existsSync(handoff.path)).toBe(false);
    const record = {
      generated_at: new Date().toISOString(),
      gotrue: 'supabase/auth v2.197.0（本机，tests/db/gotrue.ts）',
      handoff_file: {
        dir_mode: (dirSt.mode & 0o777).toString(8),
        file_mode: (fileSt.mode & 0o777).toString(8),
        owner_uid_is_current: fileSt.uid === process.getuid?.(),
        lines: lines.length,
      },
      run_id: runId,
      attempt_id: attemptId,
      results,
      login_with_handoff_password: lines.map((l) => ({ email: l.email, status: 200 })),
      save_login_calls_stub: saveLoginCalls,
      shredded: true,
      vault_touched: false,
    };
    const blob = JSON.stringify(record);
    for (const l of lines) expect(blob).not.toContain(l.password);
    if (process.env.SBTEST_DEMO_OUT)
      writeFileSync(process.env.SBTEST_DEMO_OUT, JSON.stringify(record, null, 2) + '\n');
  });
});
