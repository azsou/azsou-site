#!/usr/bin/env node
/**
 * 安全头检查（vercel.json）：
 *  1. 构建产物里每一段内联 <script>（非 JSON）的 sha256 都在 CSP 的 script-src 里——否则上线后脚本被拦。
 *     `--write` 把 script-src 的哈希更新为当前产物的哈希（改了内联脚本后跑一次再提交）。
 *  2. CSP 包含必要指令：Supabase（REST / Auth / Storage 图片 / Realtime）、Turnstile、object-src 'none'、
 *     frame-ancestors、base-uri 等；以及 nosniff、Referrer-Policy、HSTS 等其他安全头。
 *  3. `--url https://预览地址`：请求线上几个页面，核对实际响应头与 vercel.json 一致（Vercel 预览验收用）。
 * 用法：node scripts/check-csp.mjs [--write] [--url <base>] [dir=dist/client]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const write = args.includes('--write');
const urlIdx = args.indexOf('--url');
const base = urlIdx >= 0 ? args[urlIdx + 1] : null;
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url') || 'dist/client';

const vercelPath = 'vercel.json';
const vercel = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
// 其他安全头在 "/(.*)" 规则里（含 /_astro/ 静态资源，nosniff 对脚本有效）；
// CSP 单独一条 "/((?!_astro/).*)"：CSP 只对文档与 Worker 生效，带哈希的 /_astro/ 脚本与样式不需要它，
// 不下发能省下每个资源 ~700 字节响应头（Lighthouse 的 resource-summary 预算按含响应头的传输量计）。
// /pagefind/（T7.1 全文搜索）单独一条 CSP：只有 Pagefind 的 Web Worker 需要 'wasm-unsafe-eval'，
// Worker 的 CSP 取自它自己的响应头，所以页面 CSP 不放开 WASM；两条规则不能同时匹配（两个 CSP 头会叠加生效）。
const CSP_SOURCE = '/((?!_astro/|pagefind/).*)';
const PAGEFIND_SOURCE = '/pagefind/(.*)';
const globalRule = vercel.headers.find((h) => h.source === '/(.*)');
const cspRule = vercel.headers.find((h) => h.source === CSP_SOURCE);
const header = (k) => globalRule?.headers.find((h) => h.key.toLowerCase() === k.toLowerCase());
const cspHeader = cspRule?.headers.find((h) => h.key === 'Content-Security-Policy');
const fail = [];

if (!cspHeader) {
  console.error(`✗ vercel.json 的 "${CSP_SOURCE}" 规则里没有 Content-Security-Policy`);
  process.exit(1);
}
if (header('Content-Security-Policy'))
  fail.push('"/(.*)" 规则里不要再放 CSP（会和单独的 CSP 规则重复下发，也会加到 /_astro/ 资源上）');

const parse = (csp) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...vals] = d.split(/\s+/);
        return [name.toLowerCase(), vals];
      }),
  );

// ---------------------------------------------------------------- 1. 内联脚本哈希
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.html') ? [p] : [];
  });
}
const hashes = new Map();
if (fs.existsSync(dir)) {
  for (const f of walk(dir)) {
    const html = fs.readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      const [, attrs, body] = m;
      const type = /\btype=["']?([^"'\s>]+)/.exec(attrs)?.[1] ?? '';
      if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
      const h = `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
      if (!hashes.has(h)) hashes.set(h, path.relative(dir, f));
    }
    if (/\son[a-z]+=["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')))
      fail.push(`${path.relative(dir, f)}：有内联事件处理器（onclick= 之类），CSP 会拦截`);
  }
} else if (!base) {
  console.error(`✗ 找不到构建产物 ${dir}（先 npm run build）`);
  process.exit(1);
}

let csp = parse(cspHeader.value);
if (write && hashes.size) {
  const keep = (csp['script-src'] ?? []).filter((v) => !v.startsWith("'sha256-"));
  const next = [...keep.slice(0, 1), ...[...hashes.keys()].sort(), ...keep.slice(1)];
  cspHeader.value = cspHeader.value.replace(/script-src[^;]*/, `script-src ${next.join(' ')}`);
  fs.writeFileSync(vercelPath, JSON.stringify(vercel, null, 2) + '\n');
  console.log(`已把 ${hashes.size} 个内联脚本哈希写入 vercel.json 的 script-src`);
  csp = parse(cspHeader.value);
}
const scriptSrc = new Set(csp['script-src'] ?? []);
for (const [h, file] of hashes)
  if (!scriptSrc.has(h))
    fail.push(`内联脚本 ${h}（${file}）不在 script-src 里——运行 node scripts/check-csp.mjs --write`);
for (const v of scriptSrc)
  if (v.startsWith("'sha256-") && hashes.size && !hashes.has(v))
    console.warn(`! script-src 里的 ${v} 已没有对应的内联脚本（可用 --write 清理）`);

// ---------------------------------------------------------------- 2. 必要指令与其他安全头
const need = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://challenges.cloudflare.com'],
  'connect-src': [
    "'self'",
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://challenges.cloudflare.com',
  ],
  'img-src': ["'self'", 'https://*.supabase.co', 'data:'],
  'frame-src': ['https://challenges.cloudflare.com', 'https://www.youtube-nocookie.com'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'self'"],
  'form-action': ["'self'"],
  'worker-src': ["'self'"],
};
for (const [d, vals] of Object.entries(need))
  for (const v of vals) if (!(csp[d] ?? []).includes(v)) fail.push(`CSP ${d} 缺少 ${v}`);

// 视频嵌入（T6.7）：frame-src 只放 Turnstile 与实际用到的视频平台嵌入域名，不放平台主站、不用通配符。
// 用了哔哩哔哩视频（src/content/videos/*.md 里 "provider": "bilibili"）才需要 player.bilibili.com。
const VIDEO_FRAMES = { youtube: 'https://www.youtube-nocookie.com', bilibili: 'https://player.bilibili.com' };
const videoDir = 'src/content/videos';
const usedProviders = new Set(
  fs.existsSync(videoDir)
    ? fs
        .readdirSync(videoDir)
        .filter((f) => f.endsWith('.md'))
        .map(
          (f) =>
            /"provider":\s*"([a-z]+)"/.exec(fs.readFileSync(path.join(videoDir, f), 'utf8'))?.[1] ??
            'youtube',
        )
    : [],
);
const allowedFrames = new Set([
  'https://challenges.cloudflare.com',
  ...[...usedProviders].map((p) => VIDEO_FRAMES[p]),
]);
for (const p of usedProviders)
  if (!VIDEO_FRAMES[p]) fail.push(`视频平台 ${p} 没有登记嵌入域名（scripts/check-csp.mjs 的 VIDEO_FRAMES）`);
  else if (!(csp['frame-src'] ?? []).includes(VIDEO_FRAMES[p]))
    fail.push(`CSP frame-src 缺少 ${VIDEO_FRAMES[p]}（有 ${p} 视频）`);
for (const v of csp['frame-src'] ?? [])
  if (!allowedFrames.has(v))
    fail.push(`CSP frame-src 不应包含 ${v}（只允许 Turnstile 与实际用到的视频嵌入域名）`);
// Pagefind：Worker 的 CSP 只多一个 'wasm-unsafe-eval'，其余全部收紧；页面 CSP 不能有它
const pfRule = vercel.headers.find((h) => h.source === PAGEFIND_SOURCE);
const pfCsp = pfRule?.headers.find((h) => h.key === 'Content-Security-Policy');
if (!pfCsp)
  fail.push(`vercel.json 缺少 "${PAGEFIND_SOURCE}" 的 CSP（Pagefind Worker 需要 'wasm-unsafe-eval'）`);
else {
  const p = parse(pfCsp.value);
  if (!(p['script-src'] ?? []).includes("'wasm-unsafe-eval'"))
    fail.push("Pagefind CSP 缺少 'wasm-unsafe-eval'");
  if ((p['default-src'] ?? []).join(' ') !== "'none'") fail.push("Pagefind CSP 的 default-src 应为 'none'");
  for (const bad of ["'unsafe-eval'", "'unsafe-inline'", '*', 'http:', 'https:'])
    if ((p['script-src'] ?? []).includes(bad)) fail.push(`Pagefind CSP script-src 不应包含 ${bad}`);
  const toRe = (src) => new RegExp('^' + src + '$');
  if (toRe(CSP_SOURCE).test('/pagefind/pagefind-worker.js')) fail.push('页面 CSP 规则不应匹配 /pagefind/');
}
if ((csp['script-src'] ?? []).includes("'wasm-unsafe-eval'"))
  fail.push("页面 CSP 不应包含 'wasm-unsafe-eval'（只放在 /pagefind/ 的 Worker 上）");
for (const bad of ["'unsafe-eval'", "'unsafe-inline'", '*', 'http:', 'https:'])
  if ((csp['script-src'] ?? []).includes(bad)) fail.push(`CSP script-src 不应包含 ${bad}`);
if (!('upgrade-insecure-requests' in csp)) fail.push('CSP 缺少 upgrade-insecure-requests');

const expectHeaders = {
  'X-Content-Type-Options': /^nosniff$/,
  'Referrer-Policy': /^strict-origin-when-cross-origin$/,
  'X-Frame-Options': /^SAMEORIGIN$/,
  'Strict-Transport-Security': /max-age=\d{8,}/,
  'Permissions-Policy': /camera=\(\)/,
  'Cross-Origin-Opener-Policy': /^same-origin/,
};
for (const [k, re] of Object.entries(expectHeaders)) {
  const h = header(k);
  if (!h || !re.test(h.value)) fail.push(`缺少或不正确的响应头 ${k}`);
}

// ---------------------------------------------------------------- 3. 线上核对（可选）
if (base) {
  for (const p of ['/', '/forum/', '/login/', '/admin/', '/this-page-does-not-exist/']) {
    const res = await fetch(new URL(p, base), { redirect: 'manual' });
    const got = res.headers.get('content-security-policy');
    if (got !== cspHeader.value) fail.push(`${p}：线上 CSP 与 vercel.json 不一致`);
    for (const k of Object.keys(expectHeaders))
      if (!res.headers.get(k)) fail.push(`${p}：线上缺少响应头 ${k}`);
    console.log(`${res.status} ${p}`);
  }
}

if (fail.length) {
  console.error(fail.map((f) => `✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log(`✓ CSP 与安全头检查通过（${hashes.size} 个内联脚本哈希${base ? '，线上一致' : ''}）`);
