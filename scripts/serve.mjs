#!/usr/bin/env node
/**
 * 测试用静态服务器：模拟 Vercel 对构建产物的行为
 *  - 无扩展名路径补尾斜杠（308），带扩展名路径去尾斜杠
 *  - 目录 → index.html；不存在 → 404.html（状态码 404）
 *  - 应用 vercel.json 里的 headers 与 redirects
 *  - 文本类资源按 Accept-Encoding 做 gzip（Vercel 默认压缩；不压缩会让 Lighthouse 高估 HTML 下载时间）
 * 用法：node scripts/serve.mjs [port] [dir]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const port = Number(process.argv[2] || process.env.PORT || 4321);
const root = path.resolve(process.argv[3] || 'dist/client');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg\+xml)/;
const toRegex = (src) => new RegExp('^' + src.replace(/\(\.\*\)/g, '(.*)') + '$');
const headerRules = vercel.headers.map((h) => ({ re: toRegex(h.source), headers: h.headers }));
const redirects = (vercel.redirects || []).map((r) => ({
  re: toRegex(r.source.replace(/\./g, '\\.')),
  to: r.destination,
  code: r.permanent ? 308 : 307,
}));

// 线上是 https；本地 http 下 upgrade-insecure-requests 会把同源子资源升级成 https 而失败——本地去掉这一条，其余 CSP 原样生效
const localValue = (h) =>
  h.key.toLowerCase() === 'content-security-policy'
    ? h.value.replace(/;\s*upgrade-insecure-requests\s*(?=;|$)/, '')
    : h.value;

function applyHeaders(res, pathname) {
  for (const rule of headerRules)
    if (rule.re.test(pathname)) for (const h of rule.headers) res.setHeader(h.key, localValue(h));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  applyHeaders(res, p);
  for (const r of redirects) if (r.re.test(p)) return res.writeHead(r.code, { Location: r.to }).end();
  if (!path.extname(p) && !p.endsWith('/')) return res.writeHead(308, { Location: p + '/' + u.search }).end();
  if (path.extname(p.replace(/\/$/, '')) && p.endsWith('/') && p !== '/')
    return res.writeHead(308, { Location: p.slice(0, -1) }).end();
  let file = path.join(root, p);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  let status = 200;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, '404.html');
    status = 404;
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const gzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const headers = { 'Content-Type': type, Vary: 'Accept-Encoding' };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const body = fs.readFileSync(file);
  res.end(gzip ? zlib.gzipSync(body) : body);
});
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
