#!/usr/bin/env node
/**
 * I01（b）真实链路验收（T046 / T074，只在隔离 Supabase 测试项目 azsou-test 上）。
 * 清单与前提：docs/audits/evidence/batch1/i01/real-acceptance.md；人工证据清单：同目录 manual-evidence.md。
 *
 * 与 tests/db/i01-official-keys.test.ts（官方测试密钥回归，本地 GoTrue + Cloudflare 官方测试 secret）不同：
 * 这里只连 azsou-test（ovvfwkmqlejcpatmfqcd，scripts/supabase-env.mjs 的测试项目允许清单）与指向它的测试预览站。
 *
 * 每个预期用例（EXPECTED）必须以下列一种方式「执行并通过」：
 *   - 自动：脚本自己发请求验证（需要收件箱 API 的步骤在没有 I01_INBOX_* 时不能自动跑）；
 *   - 人工证据：--manual-evidence=<目录>，目录里 manifest.json 按 MANUAL_CHECKLIST 给出该用例的观测值与产物（截图等，
 *     带 sha256），脚本逐项校验（产物存在、哈希一致、图片格式、时间、项目 ref、站点源、候选 SHA、观测值满足通过条件）。
 *     收件箱目前只能人工收信，所以真实邮件确认 / 真实 Turnstile 成功路径 / GitHub OAuth 走这条。
 *
 * 用法：
 *   I01_CONFIRM_ISOLATED=1 I01_SUPABASE_URL=https://ovvfwkmqlejcpatmfqcd.supabase.co I01_SUPABASE_ANON_KEY=… \
 *   I01_SITE_URL=https://<预览站> [I01_INBOX_API=… I01_INBOX_TOKEN=… I01_INBOX_DOMAIN=…] \
 *   node scripts/i01/real-acceptance.mjs [--manual-evidence=<目录>] [--only=T046-4,…]
 * 输出：test-results/i01-real/report.json（只记状态码 / 错误码 / 跳转目标的源与路径；不记密码、cookie、token、密钥、邮件正文）。
 *
 * 退出码（只有 0 表示验收通过）：
 *   0 = 每个预期用例都执行了且全部通过（执行数 = 预期数，无 fail / blocked / 未执行）；
 *   1 = 至少一个用例失败（含人工证据校验不通过）；
 *   2 = 前提缺失或目标不在允许清单（一个请求都没发）；
 *   3 = 有用例阻塞（BLOCKED）或没执行（部分运行，例如 --only、缺收件箱又没有人工证据）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifySupabaseUrl } from '../supabase-env.mjs';

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, PRECONDITION: 2, INCOMPLETE: 3 });

/** 预期用例：验收通过 = 这些全部执行且通过 */
export const EXPECTED = Object.freeze([
  {
    id: 'T046-1',
    title: '注册确认：真实邮件 → 链接回本站 /auth/callback/ → 会话；同一链接重放被拒',
    needsInbox: true,
  },
  { id: 'T046-2', title: '找回密码：真实邮件 → recovery 链接 → 只用一次', needsInbox: true },
  { id: 'T046-3', title: 'redirect 白名单：外域 / 点段 redirect_to 回落到本站', needsInbox: true },
  { id: 'T046-4', title: '过期 / 伪造 token 被拒', needsInbox: false },
  {
    id: 'T046-5',
    title: 'Turnstile 真实密钥：真实挑战通过 → 注册成功；测试 token → /api/auth 400；限流 429',
    needsInbox: false,
  },
  {
    id: 'T046-6',
    title:
      'GitHub OAuth（azsou-test 的 GitHub 提供方）：授权 → PKCE 回调 → 会话 → 回 next；重放 code / 错 state 被拒',
    needsInbox: false,
  },
  {
    id: 'T074',
    title: '回调参数重放：过期、重复、错 state / PKCE、外域 next 全表 → 被拒或安全幂等',
    needsInbox: false,
  },
]);

/**
 * 人工证据清单：每个用例必须给的产物（kind → 说明）与观测值（字段 → 通过条件）。
 * 产物路径相对证据目录；截图须是 PNG / JPEG；邮件截图须遮住链接里的 token。
 * 通过条件里的 ctx = { siteOrigin }。
 */
export const MANUAL_CHECKLIST = Object.freeze({
  'T046-1': {
    artifacts: {
      'inbox-confirmation':
        '收件箱里 azsou-test 发出的注册确认邮件截图（发件人 / 主题 / 收件时间可见，链接 token 打码）',
      'callback-signed-in':
        '点确认链接后浏览器落在 <预览站>/auth/callback/ 再到已登录状态的截图（地址栏可见）',
      'replay-rejected': '同一确认链接第二次打开的截图（显示链接无效 / 已使用，未登录）',
    },
    observations: {
      verify_redirect_origin: (v, c) => v === c.siteOrigin,
      verify_redirect_path: (v) => v === '/auth/callback/',
      session_established: (v) => v === true,
      replay_rejected: (v) => v === true,
    },
  },
  'T046-2': {
    artifacts: {
      'inbox-recovery': '找回密码邮件截图（token 打码）',
      'recovery-landing': '点链接后落在本站并进入设置新密码界面的截图',
      'replay-rejected': '同一链接第二次打开被拒的截图',
    },
    observations: {
      verify_redirect_origin: (v, c) => v === c.siteOrigin,
      new_password_login_ok: (v) => v === true,
      replay_rejected: (v) => v === true,
    },
  },
  'T046-3': {
    artifacts: {
      'inbox-redirect-vectors': '三封以恶意 redirect_to 注册得到的确认邮件截图（token 打码）',
      'landing-origins': '三个链接打开后的落点截图（地址栏是本站源）',
    },
    observations: {
      landing_origins: (v, c) => Array.isArray(v) && v.length === 3 && v.every((o) => o === c.siteOrigin),
    },
  },
  'T046-4': {
    artifacts: {
      'forged-token-responses': '伪造 token 调 /auth/v1/user 与 /auth/v1/verify 的响应截图或 HAR',
    },
    observations: {
      user_status: (v) => v === 401 || v === 403,
      verify_session_issued: (v) => v === false,
    },
  },
  'T046-5': {
    artifacts: {
      'turnstile-widget-passed': '预览站 /register/ 上真实 Turnstile 挑战通过的截图（小组件显示成功）',
      'register-success': '提交后显示「查收确认邮件」的截图',
      'inbox-confirmation': '对应的真实确认邮件截图（token 打码）',
      'fake-token-rejected': '测试 token 打真实密钥 → /api/auth/signup 400 turnstile_failed 的响应截图或 HAR',
      'rate-limited': '超过「每小时邮件数」后 429 over_email_send_rate_limit 的截图或 HAR',
    },
    observations: {
      turnstile_real_key: (v) => v === true,
      register_api_status: (v) => v === 200,
      fake_token_status: (v) => v === 400,
      rate_limit_status: (v) => v === 429,
    },
  },
  'T046-6': {
    artifacts: {
      'github-consent': 'github.com 授权页截图（应用名 = azsou-test 的 OAuth 应用，测试账号登录）',
      'final-signed-in': '授权后回到 <预览站>/forum/（next）且已登录的截图',
      'code-replay-rejected': '重放同一 ?code= 回调地址被拒的截图',
      'bad-state-rejected': '伪造 state / 缺 code_verifier 被拒的截图',
    },
    observations: {
      final_origin: (v, c) => v === c.siteOrigin,
      final_path: (v) => v === '/forum/',
      code_replay_rejected: (v) => v === true,
      bad_state_rejected: (v) => v === true,
    },
  },
  T074: {
    artifacts: {
      'callback-replay-table': '回调参数重放全表（tests/redirect-vectors.ts）的执行记录截图或 HAR',
    },
    observations: {
      vectors_total: (v) => Number.isInteger(v) && v > 0,
      vectors_rejected_or_idempotent: (v, _c, o) => v === o.vectors_total,
      offsite_navigations: (v) => v === 0,
    },
  },
});

export const TEST_PROJECT_REF = 'ovvfwkmqlejcpatmfqcd';
const MAX_EVIDENCE_AGE_DAYS = 30;

/** 汇总：执行数必须等于预期数且全部通过才是 0 */
export function summarize(results, expected = EXPECTED) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const notRun = expected.filter((e) => !byId.has(e.id)).map((e) => e.id);
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.id);
  const blockedIds = results.filter((r) => r.status === 'blocked').map((r) => r.id);
  const passed = results.filter((r) => r.status === 'pass').map((r) => r.id);
  const exitCode = failed.length
    ? EXIT.FAIL
    : blockedIds.length || notRun.length || passed.length !== expected.length
      ? EXIT.INCOMPLETE
      : EXIT.PASS;
  const verdict = exitCode === EXIT.PASS ? 'PASS' : exitCode === EXIT.FAIL ? 'FAIL' : 'INCOMPLETE';
  return {
    verdict,
    exitCode,
    expected: expected.length,
    executed: passed.length + failed.length,
    passed,
    failed,
    blocked: blockedIds,
    notRun,
  };
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const isImage = (buf) =>
  (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
  (buf[0] === 0xff && buf[1] === 0xd8);

/**
 * 校验人工证据目录；返回 { ok, errors, steps: Map<id, {status, notes}> }。
 * 顶层：project_ref = azsou-test、site_origin = I01_SITE_URL 的源、candidate_sha 为 40 位、operator 非空。
 */
export function loadManualEvidence(dir, { siteOrigin, now = new Date() }) {
  const errors = [];
  const steps = new Map();
  const mf = path.join(dir, 'manifest.json');
  if (!existsSync(mf)) return { ok: false, errors: [`缺 ${mf}`], steps };
  let m;
  try {
    m = JSON.parse(readFileSync(mf, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`manifest.json 不是合法 JSON：${e.message}`], steps };
  }
  if (m.project_ref !== TEST_PROJECT_REF) errors.push(`project_ref 必须是 ${TEST_PROJECT_REF}（azsou-test）`);
  if (m.site_origin !== siteOrigin)
    errors.push(`site_origin（${m.site_origin}）与 I01_SITE_URL 的源（${siteOrigin}）不一致`);
  if (!/^[0-9a-f]{40}$/.test(m.candidate_sha ?? '')) errors.push('candidate_sha 必须是完整 40 位提交 SHA');
  if (!String(m.operator ?? '').trim()) errors.push('operator（执行人）不能为空');
  const top = errors.length;
  const ctx = { siteOrigin };
  for (const [id, spec] of Object.entries(MANUAL_CHECKLIST)) {
    const s = m.steps?.[id];
    if (!s) continue; // 没给 = 这个用例没有人工证据
    const notes = [];
    const bad = (msg) => notes.push(msg);
    if (top) bad('顶层字段不合格（见 errors）');
    const at = Date.parse(s.performed_at ?? '');
    if (!Number.isFinite(at)) bad('performed_at 不是时间');
    else if (at > now.getTime() + 5 * 60_000) bad('performed_at 在未来');
    else if (now.getTime() - at > MAX_EVIDENCE_AGE_DAYS * 86_400_000)
      bad(`performed_at 超过 ${MAX_EVIDENCE_AGE_DAYS} 天`);
    if (s.result !== 'pass' && s.result !== 'fail') bad('result 必须是 pass 或 fail');
    const arts = new Map((s.artifacts ?? []).map((a) => [a.kind, a]));
    for (const kind of Object.keys(spec.artifacts)) {
      const a = arts.get(kind);
      if (!a) {
        bad(`缺产物 ${kind}`);
        continue;
      }
      const rel = String(a.path ?? '');
      const abs = path.resolve(dir, rel);
      if (!rel || path.isAbsolute(rel) || !abs.startsWith(path.resolve(dir) + path.sep)) {
        bad(`产物 ${kind} 路径必须在证据目录内`);
        continue;
      }
      if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size === 0) {
        bad(`产物 ${kind} 文件不存在或为空：${rel}`);
        continue;
      }
      if (sha256File(abs) !== String(a.sha256 ?? '').toLowerCase())
        bad(`产物 ${kind} 的 sha256 与清单不一致`);
      if (/\.(png|jpe?g)$/i.test(rel) && !isImage(readFileSync(abs).subarray(0, 4)))
        bad(`产物 ${kind} 不是有效的 PNG / JPEG`);
      if (!/\.(png|jpe?g|har|json|txt)$/i.test(rel))
        bad(`产物 ${kind} 格式只能是 png / jpg / har / json / txt`);
    }
    const obs = s.observations ?? {};
    for (const [field, ok] of Object.entries(spec.observations)) {
      if (!(field in obs)) bad(`缺观测值 ${field}`);
      else if (!ok(obs[field], ctx, obs)) bad(`观测值 ${field}=${JSON.stringify(obs[field])} 不满足通过条件`);
    }
    const status = notes.length ? 'fail' : s.result === 'pass' ? 'pass' : 'fail';
    if (!notes.length && s.result === 'fail') notes.push('执行人记录为失败');
    steps.set(id, { status, notes: notes.length ? notes : ['人工证据校验通过'] });
  }
  return { ok: errors.length === 0, errors, steps };
}

/** 前提 + 允许清单；返回 { ok, errors, cfg } */
export function checkPreconditions(env) {
  const errors = [];
  const need = {
    I01_CONFIRM_ISOLATED: '必须为 1：确认目标是隔离测试项目 azsou-test（不是生产）',
    I01_SUPABASE_URL: `azsou-test 的 URL（https://${TEST_PROJECT_REF}.supabase.co）`,
    I01_SUPABASE_ANON_KEY: 'azsou-test 的 anon / publishable key',
    I01_SITE_URL:
      '指向 azsou-test 的测试预览站（Auth 的 Site URL / Redirect URLs 已配成它的 /auth/callback/**）',
  };
  for (const [k, why] of Object.entries(need))
    if (!env[k] || (k === 'I01_CONFIRM_ISOLATED' && env[k] !== '1')) errors.push(`缺 ${k}：${why}`);
  if (errors.length) return { ok: false, errors };
  const c = classifySupabaseUrl(env.I01_SUPABASE_URL);
  if (!c || c.target !== 'test' || c.ref !== TEST_PROJECT_REF)
    errors.push(`拒绝：I01_SUPABASE_URL 不是允许清单里的测试项目 ${TEST_PROJECT_REF}`);
  let siteOrigin = '';
  try {
    const u = new URL(env.I01_SITE_URL);
    if (u.protocol !== 'https:') errors.push('I01_SITE_URL 必须是 https 预览站');
    siteOrigin = u.origin;
  } catch {
    errors.push('I01_SITE_URL 不是 URL');
  }
  if (/^https:\/\/(www\.)?azsou\.com$/.test(siteOrigin)) errors.push('拒绝：I01_SITE_URL 是生产站点');
  if (/^(sb_secret_)/.test(env.I01_SUPABASE_ANON_KEY))
    errors.push('拒绝：I01_SUPABASE_ANON_KEY 是 secret key');
  const inbox = Boolean(env.I01_INBOX_API && env.I01_INBOX_TOKEN && env.I01_INBOX_DOMAIN);
  return {
    ok: errors.length === 0,
    errors,
    cfg: {
      SB: env.I01_SUPABASE_URL.replace(/\/$/, ''),
      SITE: env.I01_SITE_URL.replace(/\/$/, ''),
      siteOrigin,
      inbox,
    },
  };
}

// ---------------------------------------------------------------- 自动步骤
function automatedSteps(env, cfg) {
  const { SB, SITE, siteOrigin } = cfg;
  const redact = (u) => {
    try {
      const x = new URL(u, SITE);
      return `${x.origin}${x.pathname}`; // 不记查询串 / 锚点（里面可能有 token）
    } catch {
      return '(无法解析)';
    }
  };
  const blocked = (m) => Object.assign(new Error(m), { blocked: true });
  const assert = (c, m) => {
    if (!c) throw new Error(m);
  };
  const auth = (p, body, q = '') =>
    fetch(`${SB}/auth/v1/${p}${q}`, {
      method: 'POST',
      headers: { apikey: env.I01_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** 收件箱适配（Mailpit 风格 HTTP API；换供应商只改这里） */
  async function waitForLink(to, timeoutMs = 120_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await fetch(`${env.I01_INBOX_API}/search?query=${encodeURIComponent(`to:${to}`)}`, {
        headers: { authorization: `Bearer ${env.I01_INBOX_TOKEN}` },
      });
      if (r.ok) {
        const id = (await r.json()).messages?.[0]?.ID;
        if (id) {
          const m = await (
            await fetch(`${env.I01_INBOX_API}/message/${id}`, {
              headers: { authorization: `Bearer ${env.I01_INBOX_TOKEN}` },
            })
          ).json();
          const link = String(m.HTML ?? m.Text ?? '').match(
            /https:\/\/[^"'\s<>]+\/auth\/v1\/verify[^"'\s<>]*/,
          )?.[0];
          if (link) return link.replace(/&amp;/g, '&');
        }
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`收件箱 ${timeoutMs / 1000}s 内没有收到 ${to} 的验证邮件`);
  }
  const follow = async (url) => (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '';
  const stamp = Date.now();
  const mail = (tag) => `i01-${tag}-${stamp}@${env.I01_INBOX_DOMAIN}`;
  const PW = `I01-${stamp}-Aa!`; // 只用于本次测试账号，不写入报告
  const needInbox = () => {
    if (!cfg.inbox)
      throw blocked('没有可程序读取的收件箱（I01_INBOX_*），且没有该用例的人工证据（--manual-evidence）');
  };

  return {
    'T046-1': async (note) => {
      needInbox();
      const to = mail('signup');
      const r = await auth(
        'signup',
        { email: to, password: PW },
        `?redirect_to=${encodeURIComponent(`${SITE}/auth/callback/`)}`,
      );
      note(`signup → ${r.status}`);
      assert(
        r.status === 200,
        `signup 状态 ${r.status}（400 captcha_failed = 测试项目开了 Turnstile，走 T046-5 的人工证据）`,
      );
      const link = await waitForLink(to);
      const loc = await follow(link);
      note(`verify → ${redact(loc)}`);
      assert(
        new URL(loc).origin === siteOrigin && new URL(loc).pathname === '/auth/callback/',
        '确认链接没有跳回本站回调页',
      );
      assert(/access_token=|code=/.test(loc), '回调没有带会话（token 或 PKCE code）');
      const loc2 = await follow(link);
      note(`verify（重放）→ ${redact(loc2)}`);
      assert(!/access_token=/.test(loc2), '确认链接可以重复使用（应被拒）');
    },
    'T046-2': async (note) => {
      needInbox();
      const to = mail('signup');
      const r = await auth(
        'recover',
        { email: to },
        `?redirect_to=${encodeURIComponent(`${SITE}/auth/callback/`)}`,
      );
      note(`recover → ${r.status}`);
      assert(r.status === 200, `recover 状态 ${r.status}`);
      const link = await waitForLink(to);
      const loc = await follow(link);
      note(`verify → ${redact(loc)}`);
      assert(new URL(loc).origin === siteOrigin, '找回链接跳到了外站');
      assert(!/access_token=/.test(await follow(link)), '找回链接可以重复使用（应被拒）');
    },
    'T046-3': async (note) => {
      needInbox();
      let i = 0;
      for (const bad of [
        'https://evil.example/',
        `${SITE}/auth/callback/..//evil.example`,
        '//evil.example/',
      ]) {
        const to = mail(`redir${i++}`);
        await auth('signup', { email: to, password: PW }, `?redirect_to=${encodeURIComponent(bad)}`);
        const loc = await follow(await waitForLink(to));
        note(`${bad} → ${redact(loc)}`);
        assert(new URL(loc).origin === siteOrigin, `redirect_to=${bad} 跳到了外站`);
      }
    },
    'T046-4': async (note) => {
      const r = await fetch(`${SB}/auth/v1/user`, {
        headers: { apikey: env.I01_SUPABASE_ANON_KEY, authorization: 'Bearer forged.jwt.token' },
      });
      note(`/user（伪造）→ ${r.status}`);
      assert(r.status === 401 || r.status === 403, '伪造 token 没有被拒');
      const v = await follow(
        `${SB}/auth/v1/verify?token=000000-expired-or-forged&type=signup&redirect_to=${encodeURIComponent(`${SITE}/auth/callback/`)}`,
      );
      note(`verify（伪造）→ ${redact(v)}`);
      assert(!/access_token=/.test(v), '伪造确认 token 换到了会话');
    },
    'T046-5': async () => {
      // 成功路径需要真实浏览器完成真实 Turnstile 挑战并人工收信：只能由人工证据完成，脚本不会把它记为通过
      throw blocked(
        '真实 Turnstile 成功路径 + 真实确认邮件 + 限流需要人工证据（manual-evidence.md 的 T046-5）',
      );
    },
    'T046-6': async () => {
      throw blocked('GitHub OAuth 真实授权需要人工证据（manual-evidence.md 的 T046-6）');
    },
    T074: async () => {
      throw blocked('回调参数重放全表需要已登录的真实会话：人工证据（manual-evidence.md 的 T074）');
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, out = 'test-results/i01-real') {
  const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) ?? '').slice(name.length + 3);
  const only = arg('only').split(',').filter(Boolean);
  const pre = checkPreconditions(env);
  if (!pre.ok) {
    console.error('I01 真实链路验收：前提缺失 / 目标不在允许清单（未发出任何请求）：');
    for (const e of pre.errors) console.error(`  - ${e}`);
    console.error('VERDICT INCOMPLETE（退出码 2）');
    return EXIT.PRECONDITION;
  }
  const { cfg } = pre;
  let manual = { ok: true, errors: [], steps: new Map() };
  const evDir = arg('manual-evidence');
  if (evDir) {
    manual = loadManualEvidence(path.resolve(evDir), { siteOrigin: cfg.siteOrigin });
    for (const e of manual.errors) console.error(`人工证据：${e}`);
  }
  const auto = automatedSteps(env, cfg);
  const results = [];
  for (const { id, title } of EXPECTED) {
    if (only.length && !only.includes(id)) continue; // 没执行 → summarize 记为 notRun（退出码 3）
    let r;
    if (manual.steps.has(id)) r = { id, title, mode: 'manual', ...manual.steps.get(id) };
    else {
      r = { id, title, mode: 'auto', status: 'pass', notes: [] };
      try {
        await auto[id]((m) => r.notes.push(m));
      } catch (e) {
        r.status = e && e.blocked ? 'blocked' : 'fail';
        r.notes.push(String(e && e.message ? e.message : e));
      }
    }
    results.push(r);
    console.log(
      `${r.status.toUpperCase().padEnd(7)} ${id} [${r.mode}] ${title}${r.status === 'pass' ? '' : ` — ${r.notes.at(-1)}`}`,
    );
  }
  const s = summarize(results);
  console.log(
    `VERDICT ${s.verdict}：预期 ${s.expected}，执行 ${s.executed}，通过 ${s.passed.length}，失败 ${s.failed.length}，阻塞 ${s.blocked.length}，未执行 ${s.notRun.length}（退出码 ${s.exitCode}）`,
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        when: new Date().toISOString(),
        site: cfg.siteOrigin,
        summary: s,
        manualErrors: manual.errors,
        results,
      },
      null,
      2,
    ),
  );
  return s.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
