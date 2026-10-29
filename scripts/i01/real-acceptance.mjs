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
 *   I01_SITE_URL=https://<预览站的唯一部署地址> I01_CANDIDATE_SHA=<40 位> I01_GITHUB_DEPLOYMENT_ID=<GitHub deployment id> \
 *   [I01_VERCEL_DEPLOYMENT_ID=dpl_…] [I01_INBOX_API=… I01_INBOX_TOKEN=… I01_INBOX_DOMAIN=…] \
 *   node scripts/i01/real-acceptance.mjs [--manual-evidence=<目录>] [--only=T046-4,…]
 * 输出：test-results/i01-real/report.json（只记状态码 / 错误码 / 跳转目标的源与路径；不记密码、cookie、token、密钥、邮件正文）。
 *
 * 第七轮（2026-10-29）：
 *   - 稳定候选域名（Vercel 分支别名）不再硬拒：验收前后各记录一次「域名 → Vercel 部署 id → SHA → 候选分支头」映射
 *     （scripts/i01/mapping.mjs，只读 Vercel / GitHub API）；开始前映射必须指向候选且分支头 = 候选（冻结推送），
 *     前后不一致 → 证据作废（退出码 3）。人工证据顶层 deployment_mapping.before / after 必须与脚本记录一致。
 *   - 用户验收通道与管理通道分开（scripts/i01/channels.mjs）：用户 / anon / 封禁 / RLS 请求只走直连通道，
 *     头里只能有 anon key 与用户 JWT；第一次请求前做金丝雀（只带 anon 读 Auth Admin 必须 401 / 403），否则停止。
 *   - T074 逐条记录 42 个 next 向量的期望落点与实际落点；3 条合法点段路径必须落到规范化后的本站路径。
 *   - T046-4 增加真实过期 token（I01_EXPIRED_ACCESS_TOKEN_FILE：azsou-test 真实签发、已过期的 access token，0600 文件）；
 *     T046-2 增加重置密码后旧密码被拒、新密码可用。真实邮件 / 限流用例仍未执行。
 *
 * 部署绑定（第六轮 ⑤，任何 Supabase / 站点请求之前）：只读 GitHub Deployments API 核对
 *   GitHub deployment I01_GITHUB_DEPLOYMENT_ID 的 sha = I01_CANDIDATE_SHA、environment = Preview、创建者 vercel[bot]、
 *   当前状态 success、状态里的 environment_url 的源 = I01_SITE_URL 的源（唯一部署地址；分支别名 *-git-* 会随新推送漂移 → 拒绝）；
 *   给了 I01_VERCEL_DEPLOYMENT_ID 时它必须出现在该部署的状态里。不符 → 退出码 2，一个验收请求都不发。
 *   人工证据的 candidate_sha 必须等于 I01_CANDIDATE_SHA；T074 必须覆盖 scripts/i01/redirect-vectors.mjs 的全表。
 *   GitHub 凭据：I01_GITHUB_TOKEN（CI）或线路注入（不带 Authorization 头）。
 *
 * 退出码（只有 0 表示验收通过）：
 *   0 = 每个预期用例都执行了且全部通过（执行数 = 预期数，无 fail / blocked / 未执行）；
 *   1 = 至少一个用例失败（含人工证据校验不通过）；
 *   2 = 前提缺失或目标不在允许清单（一个请求都没发）；
 *   3 = 有用例阻塞（BLOCKED）或没执行（部分运行，例如 --only、缺收件箱又没有人工证据）。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifySupabaseUrl } from '../supabase-env.mjs';
import {
  ChannelPolluted,
  ChannelUnavailable,
  ChannelViolation,
  adminChannel,
  jwtPayload,
  userChannel,
} from './channels.mjs';
import { mappingChanged, mappingProblems, resolveMapping } from './mapping.mjs';
import { BENIGN_DOT_NEXT, EVIL_NEXT, allVectors } from './redirect-vectors.mjs';

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
      // 第七轮：重置后旧密码必须被拒（grant_type=password → 400）
      old_password_rejected: (v) => v === true,
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
      'expired-token-lifecycle':
        '同一个真实 token 的两段记录：有效期内 /auth/v1/user 200（时间早于 exp），过期后 401/403 且正文原因是 token is expired（token 打码，只留 sha256 前 12 位）',
    },
    observations: {
      user_status: (v) => v === 401 || v === 403,
      verify_session_issued: (v) => v === false,
      // 第七轮：azsou-test 真实签发、已过期的 access token 调 /auth/v1/user 也必须被拒
      expired_user_status: (v) => v === 401 || v === 403,
      // 第八轮：拒绝原因必须明确是「过期」（GoTrue msg 含 token is expired）；错签名 / 解析错误的 bad_jwt 不算过期
      expired_reason_is_expiry: (v) => v === true,
      // 第八轮：同一个 token 在 exp 之前调 /auth/v1/user 返回 200（真实来源、有效期内被接受）
      accepted_before_exp_status: (v) => v === 200,
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
      // 第六轮 ⑤：必须是全表（scripts/i01/redirect-vectors.mjs），不能只挑几条
      vectors_total: (v) => v === allVectors().length,
      vectors_executed: (v) =>
        Array.isArray(v) &&
        v.length === allVectors().length &&
        new Set(v).size === v.length &&
        allVectors().every((x) => v.includes(x)),
      vectors_rejected_or_idempotent: (v, _c, o) => v === o.vectors_total,
      offsite_navigations: (v) => v === 0,
      // 第七轮：逐条期望 vs 实际落点（42 条各一次；3 条合法点段路径必须落到规范化后的本站路径）
      vectors: (v, c) => vectorProblems(v, c.siteOrigin).length === 0,
    },
  },
});

/** T074 每个 next 向量的期望落点：外域 / 绕过向量 → 回落 `/`；合法点段 → 规范化后的本站路径（与 safeNext 单测同一份数据） */
export function expectedLanding(input) {
  const benign = BENIGN_DOT_NEXT.find(([i]) => i === input);
  if (benign) return benign[1];
  if (EVIL_NEXT.includes(input)) return '/';
  return null;
}
/**
 * 逐条核对 T074 的实际落点：v = [{ input, landed_origin, landed_path }]（landed_path 含查询串）。
 * 返回问题列表；空 = 42 条全部执行一次且都落在期望位置。
 */
export function vectorProblems(v, siteOrigin) {
  if (!Array.isArray(v)) return ['vectors 不是数组'];
  const p = [];
  const seen = new Set();
  for (const x of v) {
    const exp = expectedLanding(x?.input);
    if (exp === null) {
      p.push(`未知向量 ${JSON.stringify(x?.input)}`);
      continue;
    }
    if (seen.has(x.input)) p.push(`重复向量 ${JSON.stringify(x.input)}`);
    seen.add(x.input);
    if (x.landed_origin !== siteOrigin) p.push(`${JSON.stringify(x.input)} 落到外站 ${x.landed_origin}`);
    else if (x.landed_path !== exp) p.push(`${JSON.stringify(x.input)} 落点 ${x.landed_path}，期望 ${exp}`);
  }
  for (const i of allVectors()) if (!seen.has(i)) p.push(`缺向量 ${JSON.stringify(i)}`);
  return p;
}
/** 报告用：逐条期望 vs 实际 */
export function vectorTable(v, siteOrigin) {
  return (Array.isArray(v) ? v : []).map((x) => {
    const expected = expectedLanding(x?.input);
    return {
      input: x?.input,
      expected: expected === null ? null : `${siteOrigin}${expected}`,
      actual: `${x?.landed_origin ?? ''}${x?.landed_path ?? ''}`,
      ok: expected !== null && x?.landed_origin === siteOrigin && x?.landed_path === expected,
    };
  });
}

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
export function loadManualEvidence(dir, { siteOrigin, candidateSha, mapping = null, now = new Date() }) {
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
  else if (candidateSha && m.candidate_sha !== candidateSha)
    errors.push(`candidate_sha（${m.candidate_sha}）不是实际部署的候选 I01_CANDIDATE_SHA（${candidateSha}）`);
  if (!String(m.operator ?? '').trim()) errors.push('operator（执行人）不能为空');
  // 第七轮：执行人前后各记录一次「域名 → 部署 id → SHA」，必须与脚本记录的映射一致（映射变了 = 证据作废）
  if (mapping) {
    for (const when of ['before', 'after']) {
      const dm = m.deployment_mapping?.[when];
      if (!dm) errors.push(`缺 deployment_mapping.${when}（域名 → 部署 id → SHA）`);
      else
        for (const k of ['domain', 'vercel_deployment_id', 'sha'])
          if (dm[k] !== mapping[k])
            errors.push(`deployment_mapping.${when}.${k}（${dm[k]}）≠ 脚本记录的映射（${mapping[k]}）`);
    }
  }
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
    if (id === 'T074' && 'vectors' in obs)
      for (const msg of vectorProblems(obs.vectors, siteOrigin).slice(0, 10)) bad(`T074 ${msg}`);
    const status = notes.length ? 'fail' : s.result === 'pass' ? 'pass' : 'fail';
    if (!notes.length && s.result === 'fail') notes.push('执行人记录为失败');
    steps.set(id, {
      status,
      notes: notes.length ? notes : ['人工证据校验通过'],
      ...(id === 'T074' ? { vectors: vectorTable(obs.vectors, siteOrigin) } : {}),
    });
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
      '指向 azsou-test 的测试预览站的唯一部署地址（Auth 的 Site URL / Redirect URLs 已配成它的 /auth/callback/**）',
    I01_CANDIDATE_SHA: '实际部署的候选提交（完整 40 位）',
    I01_GITHUB_DEPLOYMENT_ID: 'Vercel 为该候选创建的 GitHub deployment id（GitHub Deployments API）',
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
  // 第七轮：稳定候选域名（分支别名 *-git-*）不再硬拒——改为验收前后记录映射，映射变了证据作废（scripts/i01/mapping.mjs）
  if (!/^[0-9a-f]{40}$/.test(env.I01_CANDIDATE_SHA))
    errors.push('I01_CANDIDATE_SHA 必须是完整 40 位提交 SHA');
  if (!/^\d+$/.test(env.I01_GITHUB_DEPLOYMENT_ID)) errors.push('I01_GITHUB_DEPLOYMENT_ID 必须是数字');
  if (env.I01_VERCEL_DEPLOYMENT_ID && !/^dpl_[A-Za-z0-9]+$/.test(env.I01_VERCEL_DEPLOYMENT_ID))
    errors.push('I01_VERCEL_DEPLOYMENT_ID 必须形如 dpl_…');
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
      candidateSha: env.I01_CANDIDATE_SHA,
      ghDeploymentId: env.I01_GITHUB_DEPLOYMENT_ID,
      vercelDeploymentId: env.I01_VERCEL_DEPLOYMENT_ID || '',
      vercelTeamId: env.I01_VERCEL_TEAM_ID || '',
      candidateBranch: env.I01_CANDIDATE_BRANCH || undefined,
      expiredTokenFile: env.I01_EXPIRED_ACCESS_TOKEN_FILE || '',
      expiredTokenRecordFile: env.I01_EXPIRED_TOKEN_ACCEPTED_FILE || '',
    },
  };
}

export const REPO = 'azsou/azsou-site';
/**
 * 部署绑定（只读 GitHub Deployments API）：返回 { ok, errors, binding }。
 * binding 只含公开信息（deployment id、sha、environment、状态、environment_url、创建时间）。
 */
/**
 * @param {{ candidateSha: string, ghDeploymentId: string, vercelDeploymentId?: string, siteOrigin: string, deploymentOrigin?: string }} cfg
 * @param {{ fetchImpl?: (url: string, init?: any) => Promise<Response>, token?: string, apiBase?: string, repo?: string }} [opts]
 */
export async function verifyDeployment(
  { candidateSha, ghDeploymentId, vercelDeploymentId, siteOrigin, deploymentOrigin },
  { fetchImpl = fetch, token = '', apiBase = 'https://api.github.com', repo = REPO } = {},
) {
  const errors = [];
  const headers = {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const get = async (p) => {
    const r = await fetchImpl(`${apiBase}/repos/${repo}${p}`, { headers });
    if (r.status === 401 || r.status === 403 || r.status === 404)
      throw new Error(`GitHub ${p} → HTTP ${r.status}（凭据未注入 / 无权限 / 不存在）`);
    if (!r.ok) throw new Error(`GitHub ${p} → HTTP ${r.status}`);
    return r.json();
  };
  let d, statuses;
  try {
    d = await get(`/deployments/${ghDeploymentId}`);
    statuses = await get(`/deployments/${ghDeploymentId}/statuses`);
  } catch (e) {
    return { ok: false, errors: [String(e?.message ?? e)], binding: null };
  }
  if (d.sha !== candidateSha)
    errors.push(`deployment ${ghDeploymentId} 的 sha ${d.sha} ≠ I01_CANDIDATE_SHA ${candidateSha}`);
  if (String(d.environment).toLowerCase() !== 'preview')
    errors.push(`deployment environment = ${d.environment}（必须是 Preview）`);
  if (d.creator?.login !== 'vercel[bot]')
    errors.push(`deployment 创建者 ${d.creator?.login}（必须是 vercel[bot]）`);
  const cur = Array.isArray(statuses) ? statuses[0] : null;
  if (!cur) errors.push('deployment 没有任何状态');
  else {
    if (cur.state !== 'success') errors.push(`deployment 当前状态 ${cur.state}（必须是 success）`);
    let envOrigin = '';
    try {
      envOrigin = new URL(cur.environment_url).origin;
    } catch {
      /* 留空 */
    }
    // 第七轮：稳定域名时比对的是它解析到的唯一部署地址
    const want = deploymentOrigin || siteOrigin;
    if (envOrigin !== want)
      errors.push(
        `deployment 的 environment_url 源 ${envOrigin || '（无）'} ≠ ${deploymentOrigin ? '稳定域名解析到的部署地址' : 'I01_SITE_URL 源'} ${want}`,
      );
  }
  if (vercelDeploymentId) {
    const bare = vercelDeploymentId.replace(/^dpl_/, '');
    const seen = (statuses ?? []).some((x) =>
      [x.description, x.target_url, x.log_url].some((t) => String(t ?? '').includes(bare)),
    );
    if (!seen)
      errors.push(`I01_VERCEL_DEPLOYMENT_ID ${vercelDeploymentId} 没有出现在该 GitHub deployment 的状态里`);
  }
  return {
    ok: errors.length === 0,
    errors,
    binding: {
      github_deployment_id: Number(ghDeploymentId),
      sha: d.sha,
      environment: d.environment,
      created_at: d.created_at,
      state: cur?.state ?? null,
      environment_url: cur?.environment_url ?? null,
      vercel_deployment_id: vercelDeploymentId || null,
      vectors_total: allVectors().length,
    },
  };
}

// ---------------------------------------------------------------- 自动步骤
/**
 * 第八轮 T046-4：拒绝正文是否**明确**因为过期。GoTrue v2 对过期 token 回
 * `{"error_code":"bad_jwt","msg":"invalid JWT: … token has invalid claims: token is expired"}`，
 * 对错签名同样回 `bad_jwt`（msg 是 `… signature is invalid`）——所以只看 bad_jwt 不够。
 * 规则：消息里有 token is expired / token has expired / jwt expired；且没有 signature / malformed / parse 之外的过期以外原因（签名错误优先判否）。
 */
export function isExpiryRejection(body) {
  let j;
  try {
    j = JSON.parse(String(body ?? ''));
  } catch {
    return false;
  }
  if (!j || typeof j !== 'object') return false;
  const msg = [j.msg, j.message, j.error_description, j.error].filter((x) => typeof x === 'string').join(' ');
  if (/signature (is )?invalid|invalid signature|signature verification|malformed/i.test(msg)) return false;
  return /\btoken (is|has) expired\b|\bjwt expired\b|\btoken expired\b/i.test(msg);
}

/**
 * 第八轮 capture-token（实现了，真实环境未执行）：在 token **有效期内**经用户直连通道调 azsou-test /auth/v1/user，
 * 必须 200 且返回的 id = token 的 sub；把 {token_sha256, project_ref, iss, sub, exp, accepted_status, accepted_user_id, accepted_at}
 * 写成 0600 记录（不含 token 本身）。等 token 过期后 T046-4 用同一个 token + 这份记录证明「真实来源、有效期内被接受、过期后因过期被拒」。
 */
export async function captureAcceptedToken(token, { SB, out, user, anonKey = '', now = Date.now }) {
  const pl = jwtPayload(token);
  if (!pl) throw new Error('不是 JWT');
  if (pl.iss !== `${String(SB).replace(/\/$/, '')}/auth/v1`)
    throw new Error(`不是 azsou-test 签发的 token（iss ${pl.iss}）`);
  if (pl.role !== 'authenticated') throw new Error(`role 是 ${pl.role}（必须是 authenticated 用户 token）`);
  if (!(Number(pl.exp) * 1000 > now() + 30_000))
    throw new Error('token 已过期或 30 秒内过期——必须在有效期内记录');
  const r = await user(`${String(SB).replace(/\/$/, '')}/auth/v1/user`, {
    headers: { ...(anonKey ? { apikey: anonKey } : {}), authorization: `Bearer ${token}` },
  });
  if (r.status !== 200) throw new Error(`有效期内 /auth/v1/user → ${r.status}（必须 200）`);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 下面判 */
  }
  if (!body || body.id !== pl.sub) throw new Error('/auth/v1/user 返回的用户 id 与 token 的 sub 不符');
  const rec = {
    token_sha256: createHash('sha256').update(token).digest('hex'),
    project_ref: TEST_PROJECT_REF,
    iss: pl.iss,
    sub: pl.sub,
    exp: Number(pl.exp),
    accepted_status: 200,
    accepted_user_id: body.id,
    accepted_at: new Date(now()).toISOString(),
    captured_by: 'scripts/i01/real-acceptance.mjs --capture-token',
  };
  const fd = openSync(out, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(rec, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
  chmodSync(out, 0o600);
  return rec;
}

/**
 * 自动步骤。所有对测试项目 / 预览站 / 收件箱的请求都只经 user（用户验收通道，直连、只带 anon / 用户 JWT）。
 * @param {Record<string,string>} env
 * @param {any} cfg
 * @param {(url: string, init?: any) => Promise<Response>} user
 * @param {{ readFile?: (p: string) => Buffer | string, exists?: (p: string) => boolean, stat?: (p: string) => { mode: number }, now?: () => number }} [io]
 */
export function automatedSteps(env, cfg, user, io = {}) {
  const { SB, SITE, siteOrigin } = cfg;
  const readFile = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const exists = io.exists ?? existsSync;
  const stat = io.stat ?? statSync;
  const now = io.now ?? Date.now;
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
    user(`${SB}/auth/v1/${p}${q}`, {
      method: 'POST',
      headers: { apikey: env.I01_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** 收件箱适配（Mailpit 风格 HTTP API；换供应商只改这里） */
  async function waitForLink(to, timeoutMs = 120_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await user(`${env.I01_INBOX_API}/search?query=${encodeURIComponent(`to:${to}`)}`, {
        headers: { authorization: `Bearer ${env.I01_INBOX_TOKEN}` },
      });
      if (r.ok) {
        const id = (await r.json()).messages?.[0]?.ID;
        if (id) {
          const m = await (
            await user(`${env.I01_INBOX_API}/message/${id}`, {
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
  const follow = async (url) => (await user(url, { redirect: 'manual' })).headers.get('location') ?? '';
  /** 从回调地址的锚点 / 查询串取 access_token（不写进报告） */
  const tokenFrom = (loc) => {
    try {
      const u = new URL(loc);
      return (
        new URLSearchParams(u.hash.replace(/^#/, '')).get('access_token') ??
        u.searchParams.get('access_token') ??
        ''
      );
    } catch {
      return '';
    }
  };
  const passwordLogin = (email, password) =>
    user(`${SB}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.I01_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  const stamp = Date.now();
  const mail = (tag) => `i01-${tag}-${stamp}@${env.I01_INBOX_DOMAIN}`;
  const PW = `I01-${stamp}-Aa!`; // 只用于本次测试账号，不写入报告
  const PW2 = `I01-${stamp}-Bb!`; // T046-2 重置后的新密码，不写入报告
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
      const recovery = tokenFrom(loc);
      assert(recovery, '找回链接没有给出 recovery 会话');
      assert(!/access_token=/.test(await follow(link)), '找回链接可以重复使用（应被拒）');
      // 第七轮：用 recovery 会话设新密码，然后旧密码必须被拒、新密码可用
      const set = await user(`${SB}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          apikey: env.I01_SUPABASE_ANON_KEY,
          authorization: `Bearer ${recovery}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ password: PW2 }),
      });
      note(`PUT /user（新密码）→ ${set.status}`);
      assert(set.status === 200, `设新密码失败 ${set.status}`);
      const oldR = await passwordLogin(to, PW);
      note(`旧密码登录 → ${oldR.status}`);
      assert(oldR.status === 400, `重置后旧密码仍可登录（${oldR.status}）`);
      const newR = await passwordLogin(to, PW2);
      note(`新密码登录 → ${newR.status}`);
      assert(newR.status === 200, `重置后新密码不能登录（${newR.status}）`);
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
      const r = await user(`${SB}/auth/v1/user`, {
        headers: { apikey: env.I01_SUPABASE_ANON_KEY, authorization: 'Bearer forged.jwt.token' },
      });
      note(`/user（伪造）→ ${r.status}`);
      assert(r.status === 401 || r.status === 403, '伪造 token 没有被拒');
      const v = await follow(
        `${SB}/auth/v1/verify?token=000000-expired-or-forged&type=signup&redirect_to=${encodeURIComponent(`${SITE}/auth/callback/`)}`,
      );
      note(`verify（伪造）→ ${redact(v)}`);
      assert(!/access_token=/.test(v), '伪造确认 token 换到了会话');
      // 第七轮：真实过期 token——azsou-test 真实签发、已过期的 access token（0600 文件，不进报告）
      const f = cfg.expiredTokenFile;
      if (!f)
        throw blocked(
          '缺 I01_EXPIRED_ACCESS_TOKEN_FILE（azsou-test 真实签发、已过期的 access token）——伪造 token 已拒，真实过期 token 未验',
        );
      if ((stat(f).mode & 0o077) !== 0) throw new Error('过期 token 文件权限必须是 0600');
      const tok = String(readFile(f)).trim();
      const pl = jwtPayload(tok);
      assert(pl, '过期 token 文件里不是 JWT');
      assert(pl.iss === `${SB}/auth/v1`, `过期 token 不是 azsou-test 签发的（iss ${pl.iss}）`);
      assert(
        pl.role === 'authenticated',
        `过期 token 的 role 是 ${pl.role}（必须是 authenticated 用户 token）`,
      );
      assert(Number(pl.exp) * 1000 < now() - 60_000, '这个 token 还没过期（exp 晚于现在 - 60 秒）');
      // 第八轮：真实来源 + 有效期内被接受——capture-token 在 exp 之前写下的记录（0600；token 只存 sha256）
      const rf = cfg.expiredTokenRecordFile;
      if (!rf || !exists(rf))
        throw blocked(
          '缺 I01_EXPIRED_TOKEN_ACCEPTED_FILE（同一 token 在有效期内被 azsou-test 接受的记录，由 --capture-token 生成）——过期拒绝无法证明不是别的原因',
        );
      if ((stat(rf).mode & 0o077) !== 0) throw new Error('有效期内接受记录文件权限必须是 0600');
      let rec;
      try {
        rec = JSON.parse(String(readFile(rf)));
      } catch {
        throw new Error('有效期内接受记录不是 JSON');
      }
      const tokSha = createHash('sha256').update(tok).digest('hex');
      assert(rec && rec.project_ref === TEST_PROJECT_REF, `接受记录不是 azsou-test（${rec?.project_ref}）`);
      assert(rec.token_sha256 === tokSha, '接受记录里的 token sha256 与过期 token 不符（不是同一个 token）');
      assert(rec.accepted_status === 200, `接受记录里有效期内的状态是 ${rec.accepted_status}（必须是 200）`);
      assert(
        rec.accepted_user_id === pl.sub && rec.sub === pl.sub,
        '接受记录里的用户不是 token 的 sub（不是同一个用户）',
      );
      const acceptedAt = Date.parse(rec.accepted_at);
      assert(
        Number.isFinite(acceptedAt) && acceptedAt < Number(pl.exp) * 1000,
        '接受记录的时间不早于 exp——不能证明在有效期内被接受',
      );
      note(
        `有效期内：${new Date(acceptedAt).toISOString()} /auth/v1/user → 200（exp ${new Date(Number(pl.exp) * 1000).toISOString()}，token sha256 ${tokSha.slice(0, 12)}…）`,
      );
      const e = await user(`${SB}/auth/v1/user`, {
        headers: { apikey: env.I01_SUPABASE_ANON_KEY, authorization: `Bearer ${tok}` },
      });
      const body = await e.text();
      note(`/user（真实过期 token）→ ${e.status}`);
      assert(e.status === 401 || e.status === 403, `真实过期 token 没有被拒（${e.status}）`);
      // 第八轮：必须是明确的过期原因；GoTrue 对错签名同样回 bad_jwt，不能算过期
      assert(
        isExpiryRejection(body),
        '拒绝原因不是「过期」（错签名 / 解析错误的 bad_jwt 不算；可能是别的错误掩盖了过期检查）',
      );
      note('过期后：401/403 且正文原因是 token is expired；exp < 现在 - 60 秒');
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

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  out = 'test-results/i01-real',
  io = {},
) {
  const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) ?? '').slice(name.length + 3);
  // 第八轮：--capture-token=<0600 token 文件> --capture-out=<记录路径>——在 token 有效期内记录「被 azsou-test 接受」（只读，用户直连通道）
  if (arg('capture-token')) {
    const sb = String(env.I01_SUPABASE_URL ?? '').replace(/\/$/, '');
    if (
      sb !== `https://${TEST_PROJECT_REF}.supabase.co` ||
      !env.I01_SUPABASE_ANON_KEY ||
      /^sb_secret_/.test(env.I01_SUPABASE_ANON_KEY)
    ) {
      console.error(
        'capture-token：I01_SUPABASE_URL 必须是 azsou-test，I01_SUPABASE_ANON_KEY 必须是 anon / publishable key',
      );
      return EXIT.PRECONDITION;
    }
    const tf = arg('capture-token');
    if ((statSync(tf).mode & 0o077) !== 0) {
      console.error('capture-token：token 文件权限必须是 0600');
      return EXIT.PRECONDITION;
    }
    const u = userChannel({
      sbOrigin: sb,
      siteOrigin: sb,
      anonKey: env.I01_SUPABASE_ANON_KEY,
      ...(io.userTransport ? { transport: io.userTransport } : {}),
    });
    const rec = await captureAcceptedToken(String(readFileSync(tf, 'utf8')).trim(), {
      SB: sb,
      out: arg('capture-out'),
      user: u,
      anonKey: env.I01_SUPABASE_ANON_KEY,
    });
    console.log(
      `已记录：有效期内 200，token sha256 ${rec.token_sha256.slice(0, 12)}…，exp ${new Date(rec.exp * 1000).toISOString()}`,
    );
    return EXIT.PASS;
  }
  const only = arg('only').split(',').filter(Boolean);
  const pre = checkPreconditions(env);
  if (!pre.ok) {
    console.error('I01 真实链路验收：前提缺失 / 目标不在允许清单（未发出任何请求）：');
    for (const e of pre.errors) console.error(`  - ${e}`);
    console.error('VERDICT INCOMPLETE（退出码 2）');
    return EXIT.PRECONDITION;
  }
  const { cfg } = pre;
  // 第七轮：管理通道（GitHub / Vercel 只读，可经注入）与用户验收通道（直连、只带 anon / 用户 JWT）分开
  const admin = adminChannel({
    transport: io.adminTransport ?? fetch,
    forbidOrigins: [cfg.SB, cfg.siteOrigin],
  });
  const mapCfg = {
    siteOrigin: cfg.siteOrigin,
    teamId: cfg.vercelTeamId,
    branch: cfg.candidateBranch,
  };
  const precond = (msgs, title) => {
    console.error(`I01 真实链路验收：${title}（未发出任何验收请求）：`);
    for (const e of msgs) console.error(`  - ${e}`);
    console.error('VERDICT INCOMPLETE（退出码 2）');
    return EXIT.PRECONDITION;
  };
  let before;
  try {
    before = await resolveMapping(mapCfg, admin);
  } catch (e) {
    return precond([String(e?.message ?? e)], '稳定域名 → 部署 → SHA 映射查不到');
  }
  const mp = mappingProblems(before, cfg);
  if (mp.length) return precond(mp, '稳定域名 → 部署 → SHA 映射不成立');
  const bind = await verifyDeployment(
    {
      ...cfg,
      vercelDeploymentId: before.vercel_deployment_id,
      deploymentOrigin: before.deployment_url ? `https://${before.deployment_url}` : '',
    },
    { token: env.I01_GITHUB_TOKEN || '', fetchImpl: admin },
  );
  if (!bind.ok) return precond(bind.errors, '部署绑定不成立');
  console.log(
    `映射（前）：${before.domain}（${before.kind}）→ ${before.vercel_deployment_id} → ${before.sha}；分支 ${before.branch} 头 ${before.branch_head}`,
  );
  console.log(
    `部署绑定：GitHub deployment ${bind.binding.github_deployment_id} = ${bind.binding.sha}（${bind.binding.environment}，${bind.binding.state}）→ ${bind.binding.environment_url}；T074 全表 ${bind.binding.vectors_total} 条`,
  );
  let manual = { ok: true, errors: [], steps: new Map() };
  const evDir = arg('manual-evidence');
  if (evDir) {
    manual = loadManualEvidence(path.resolve(evDir), {
      siteOrigin: cfg.siteOrigin,
      candidateSha: cfg.candidateSha,
      mapping: before,
    });
    for (const e of manual.errors) console.error(`人工证据：${e}`);
  }
  const user = userChannel({
    sbOrigin: cfg.SB,
    siteOrigin: cfg.siteOrigin,
    inboxOrigin: env.I01_INBOX_API ? new URL(env.I01_INBOX_API).origin : '',
    anonKey: env.I01_SUPABASE_ANON_KEY,
    ...(io.userTransport ? { transport: io.userTransport } : {}),
  });
  const auto = automatedSteps(env, cfg, user, io);
  const results = [];
  let polluted = '';
  for (const { id, title } of EXPECTED) {
    if (only.length && !only.includes(id)) continue; // 没执行 → summarize 记为 notRun（退出码 3）
    let r;
    if (manual.steps.has(id)) r = { id, title, mode: 'manual', ...manual.steps.get(id) };
    else if (polluted) r = { id, title, mode: 'auto', status: 'blocked', notes: [polluted] };
    else {
      r = { id, title, mode: 'auto', status: 'pass', notes: [] };
      try {
        await auto[id]((m) => r.notes.push(m));
      } catch (e) {
        if (e instanceof ChannelUnavailable) {
          polluted = `用户直连通道不可用，验收停止（不回退到管理 / 代理通道）：${e.message}`;
          r.status = 'blocked';
        } else if (e instanceof ChannelPolluted || e instanceof ChannelViolation) {
          polluted = `用户通道不干净，验收停止：${e.message}`;
          r.status = 'blocked';
        } else r.status = e && e.blocked ? 'blocked' : 'fail';
        r.notes.push(String(e && e.message ? e.message : e));
      }
    }
    results.push(r);
    console.log(
      `${r.status.toUpperCase().padEnd(7)} ${id} [${r.mode}] ${title}${r.status === 'pass' ? '' : ` — ${r.notes.at(-1)}`}`,
    );
  }
  const s = summarize(results);
  // 第七轮：验收结束再记录一次映射；任何变化 → 本次证据作废（不是通过）
  let after = null;
  let changed;
  try {
    after = await resolveMapping(mapCfg, admin);
    changed = mappingChanged(before, after);
  } catch (e) {
    changed = [`验收后映射查不到：${String(e?.message ?? e)}`];
  }
  if (changed.length) {
    s.invalidated = changed;
    if (s.exitCode === EXIT.PASS) {
      s.exitCode = EXIT.INCOMPLETE;
      s.verdict = 'INCOMPLETE';
    }
    console.error(`映射在验收期间变化，本次证据作废：${changed.join('；')}`);
  }
  if (polluted) s.channel = polluted;
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
        mapping: { before, after, changed },
        binding: bind.binding,
        summary: s,
        manualErrors: manual.errors,
        user_channel: user.log,
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
