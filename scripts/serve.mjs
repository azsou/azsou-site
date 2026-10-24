#!/usr/bin/env node
/**
 * 测试用静态服务器：模拟 Vercel 对构建产物的行为
 *  - 无扩展名路径补尾斜杠（308），带扩展名路径去尾斜杠
 *  - 目录 → index.html；不存在 → 404.html（状态码 404）
 *  - 应用 vercel.json 里的 headers 与 redirects
 * 用法：node scripts/serve.mjs [port] [dir]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};
const toRegex = (src) => new RegExp('^' + src.replace(/\(\.\*\)/g, '(.*)') + '$');
const headerRules = vercel.headers.map((h) => ({ re: toRegex(h.source), headers: h.headers }));
const redirects = (vercel.redirects || []).map((r) => ({
  re: toRegex(r.source.replace(/\./g, '\\.')),
  to: r.destination,
  code: r.permanent ? 308 : 307,
}));

function applyHeaders(res, pathname) {
  for (const rule of headerRules)
    if (rule.re.test(pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
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
  res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
