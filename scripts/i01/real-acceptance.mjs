#!/usr/bin/env node
/**
 * I01（b）真实链路验收（T046 / T074 在隔离 Supabase 测试项目上）——**尚未执行，阻塞**。
 * 清单与前提：docs/audits/evidence/batch1/i01/real-acceptance.md
 *
 * 与 tests/db/i01-official-keys.test.ts（官方测试密钥回归，本地 GoTrue + Cloudflare 官方测试 secret）不同：
 * 这里只连**隔离的 Supabase 测试项目**、真实收件箱、GitHub OAuth 测试应用、真实 Turnstile 密钥的测试预览站。
 *
 * 用法（条件齐备后）：
 *   I01_CONFIRM_ISOLATED=1 I01_SUPABASE_URL=… I01_SUPABASE_ANON_KEY=… I01_SITE_URL=… \
 *   I01_INBOX_API=… I01_INBOX_TOKEN=… I01_INBOX_DOMAIN=… node scripts/i01/real-acceptance.mjs [--only=T046-1,…]
 * 输出：test-results/i01-real/report.json（只记状态码 / 错误码 / 跳转目标的源与路径；不记密码、cookie、token、密钥、邮件正文）。
 * 退出码：0 全部通过；1 有失败；2 阻塞（缺前提，未发任何请求）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const PROD_REF = 'abryflgoljltyakthtql'; // 生产项目：永远拒绝
const REQUIRED = {
  I01_CONFIRM_ISOLATED: '必须为 1：确认目标是隔离测试项目（不是生产）',
  I01_SUPABASE_URL: '隔离 Supabase 测试项目 URL（https://<ref>.supabase.co）',
  I01_SUPABASE_ANON_KEY: '该测试项目的 anon key',
  I01_SITE_URL:
    '指向该测试项目的测试预览站（Auth 设置 Site URL / Redirect URLs 已配成它的 /auth/callback/**）',
  I01_INBOX_API: '可程序读取的测试收件箱 API 根地址（如 Mailosaur / Mailpit / 自建 IMAP 网关）',
  I01_INBOX_TOKEN: '收件箱 API 令牌',
  I01_INBOX_DOMAIN: '收件箱接收域名（每次运行生成 i01-<时间戳>@<域名>）',
};
const OPTIONAL = {
  I01_GITHUB_TEST_LOGIN:
    'GitHub OAuth 测试账号（专用、无权限）用户名——OAuth 步骤需要；缺则 OAuth 步骤记为阻塞',
  I01_GITHUB_TEST_PASSWORD: '同上，密码（只从环境变量读，不写日志）',
  I01_TURNSTILE_EXPECT_REAL: '1 = 预览站与测试项目配的是真实 Turnstile 密钥（不是官方测试密钥）',
};

const env = process.env;
const missing = Object.keys(REQUIRED).filter(
  (k) => !env[k] || (k === 'I01_CONFIRM_ISOLATED' && env[k] !== '1'),
);
const optionalMissing = Object.keys(OPTIONAL).filter((k) => !env[k]);
if (missing.length) {
  console.error('I01 真实链路验收：阻塞（未发出任何请求）。缺少：');
  for (const k of missing) console.error(`  - ${k}：${REQUIRED[k]}`);
  for (const k of optionalMissing) console.error(`  - （可选，缺则对应步骤记为阻塞）${k}：${OPTIONAL[k]}`);
  process.exit(2);
}
if (env.I01_SUPABASE_URL.includes(PROD_REF) || env.I01_SITE_URL.includes(PROD_REF)) {
  console.error(`拒绝：目标包含生产项目 ${PROD_REF}`);
  process.exit(2);
}

const SB = env.I01_SUPABASE_URL.replace(/\/$/, '');
const SITE = env.I01_SITE_URL.replace(/\/$/, '');
const SITE_ORIGIN = new URL(SITE).origin;
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const results = [];
const redact = (u) => {
  try {
    const x = new URL(u, SITE);
    return `${x.origin}${x.pathname}`; // 不记查询串 / 锚点（里面可能有 token）
  } catch {
    return '(无法解析)';
  }
};

async function step(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  const r = { id, title, status: 'pass', notes: [] };
  try {
    await fn((m) => r.notes.push(m));
  } catch (e) {
    r.status = e && e.blocked ? 'blocked' : 'fail';
    r.notes.push(String(e && e.message ? e.message : e));
  }
  results.push(r);
  console.log(`${r.status.toUpperCase().padEnd(7)} ${id} ${title}`);
}
const blocked = (m) => Object.assign(new Error(m), { blocked: true });
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const auth = (path, body, q = '') =>
  fetch(`${SB}/auth/v1/${path}${q}`, {
    method: 'POST',
    headers: { apikey: env.I01_SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 收件箱适配（Mailpit 风格 HTTP API；换供应商只改这里）：等某个收件人的最新一封邮件，返回其中第一个指向测试项目 /auth/v1/verify 的链接 */
async function waitForLink(to, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${env.I01_INBOX_API}/search?query=${encodeURIComponent(`to:${to}`)}`, {
      headers: { authorization: `Bearer ${env.I01_INBOX_TOKEN}` },
    });
    if (r.ok) {
      const j = await r.json();
      const id = j.messages?.[0]?.ID;
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
const follow = async (url) => {
  const r = await fetch(url, { redirect: 'manual' });
  return r.headers.get('location') ?? '';
};

const stamp = Date.now();
const mail = (tag) => `i01-${tag}-${stamp}@${env.I01_INBOX_DOMAIN}`;
const PW = `I01-${stamp}-Aa!`; // 只用于本次测试账号，不写入报告

// ---------------- T046 ----------------
await step('T046-1', '注册确认：真实邮件 → 链接回本站 /auth/callback/ → 会话', async (note) => {
  const to = mail('signup');
  const r = await auth(
    'signup',
    { email: to, password: PW },
    `?redirect_to=${encodeURIComponent(`${SITE}/auth/callback/`)}`,
  );
  note(`signup → ${r.status}`);
  assert(
    r.status === 200,
    `signup 状态 ${r.status}（若为 400 captcha_failed，说明测试项目开了 Turnstile，需要走预览站 /api/auth 或浏览器步骤 T046-5）`,
  );
  const link = await waitForLink(to);
  const loc = await follow(link);
  note(`verify → ${redact(loc)}`);
  assert(
    new URL(loc).origin === SITE_ORIGIN && new URL(loc).pathname === '/auth/callback/',
    '确认链接没有跳回本站回调页',
  );
  assert(/access_token=|code=/.test(loc), '回调没有带会话（token 或 PKCE code）');
  // T074：同一确认链接第二次使用
  const loc2 = await follow(link);
  note(`verify（重放）→ ${redact(loc2)}`);
  assert(!/access_token=/.test(loc2), '确认链接可以重复使用（应被拒）');
});

await step('T046-2', '找回密码：真实邮件 → recovery 链接 → 只用一次', async (note) => {
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
  assert(new URL(loc).origin === SITE_ORIGIN, '找回链接跳到了外站');
  const loc2 = await follow(link);
  assert(!/access_token=/.test(loc2), '找回链接可以重复使用（应被拒）');
});

await step('T046-3', 'redirect 白名单：外域 / 点段 redirect_to 被 GoTrue 回落到 Site URL', async (note) => {
  for (const bad of ['https://evil.example/', `${SITE}/auth/callback/..//evil.example`, '//evil.example/']) {
    const to = mail(`redir${results.length}`);
    await auth('signup', { email: to, password: PW }, `?redirect_to=${encodeURIComponent(bad)}`);
    const loc = await follow(await waitForLink(to));
    note(`${bad} → ${redact(loc)}`);
    assert(new URL(loc).origin === SITE_ORIGIN, `redirect_to=${bad} 跳到了外站`);
  }
});

await step('T046-4', '过期 / 伪造 token 被拒', async (note) => {
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
});

await step(
  'T046-5',
  'Turnstile（真实密钥）：浏览器真实挑战通过 → 注册成功；伪造 token → /api/auth 拒绝；限流',
  async (note) => {
    if (env.I01_TURNSTILE_EXPECT_REAL !== '1')
      throw blocked('预览站 / 测试项目未声明配了真实 Turnstile 密钥（I01_TURNSTILE_EXPECT_REAL=1）');
    const bad = await fetch(`${SITE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_ORIGIN },
      body: JSON.stringify({ email: mail('ts-bad'), password: PW, captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
    });
    note(`/api/auth/signup（测试 token 打真实密钥）→ ${bad.status}`);
    assert(bad.status === 400, '真实密钥下测试 token 没有被拒');
    // 成功路径与限流需要真实浏览器完成挑战：用 Playwright 打开 ${SITE}/register/，提交后断言出现「查收确认邮件」；
    // 限流按 Supabase Auth → Rate Limits 的「每小时邮件数」连续触发，断言第 N+1 次返回 429 over_email_send_rate_limit。
    throw blocked('成功路径 / 限流需要浏览器步骤（见 real-acceptance.md 第 5 步），本脚本只覆盖失败路径');
  },
);

await step(
  'T046-6',
  'GitHub OAuth 测试应用：授权 → 回调 PKCE → 会话；错 state / 重放 code 被拒',
  async () => {
    if (!env.I01_GITHUB_TEST_LOGIN || !env.I01_GITHUB_TEST_PASSWORD)
      throw blocked('缺 GitHub OAuth 测试账号（I01_GITHUB_TEST_LOGIN / I01_GITHUB_TEST_PASSWORD）');
    // Playwright：打开 ${SITE}/login/?next=/forum/ → 「使用 GitHub 登录」→ github.com 登录测试账号并授权 →
    // 断言最终 page.url() 源为 SITE_ORIGIN 且路径 /forum/；再次打开同一 ?code= 回调地址 → 页面显示「链接无法使用」；
    // 伪造 state / 缺 code_verifier → 同样被拒。实现放在 tests/e2e-real/oauth.spec.ts（条件齐备时新建，不进常规 CI）。
    throw blocked('OAuth 浏览器步骤待测试账号就绪后实现并执行');
  },
);

mkdirSync('test-results/i01-real', { recursive: true });
writeFileSync(
  'test-results/i01-real/report.json',
  JSON.stringify({ when: new Date().toISOString(), site: SITE_ORIGIN, results }, null, 2),
);
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
