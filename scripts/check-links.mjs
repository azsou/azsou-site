#!/usr/bin/env node
/**
 * 死链检查（离线，针对构建产物）：
 *  - 每个 HTML 里的 <a href>、<link href>、<img src>、<script src>、srcset
 *  - 站内链接必须能解析到 dist 中的文件；#锚点必须在目标页存在（id）；页面链接必须带尾斜杠
 *  - 站外链接只做格式检查（CI 不依赖外网）
 * 退出码非 0 表示有坏链。
 */
import fs from 'node:fs';
import path from 'node:path';
import { listRoutes } from './routes.mjs';

const dir = process.argv[2] || 'dist/client';
const SITE = 'https://azsou.com';
const cache = new Map();
const read = (f) => {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(f, 'utf8'));
  return cache.get(f);
};

function resolveFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dir, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  return null;
}
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

function extractLinks(html) {
  const links = [];
  for (const m of html.matchAll(/<(a|link|img|script|source)\b[^>]*?\s(href|src|srcset)="([^"]*)"/gi)) {
    const [, tag, attr, val] = m;
    if (tag.toLowerCase() === 'link' && /rel="(preconnect|dns-prefetch)"/.test(m[0])) continue;
    if (attr === 'srcset') val.split(',').forEach((s) => links.push(s.trim().split(/\s+/)[0]));
    else links.push(val);
  }
  // og:image / twitter:image 也必须存在
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]+content="([^"]+)"/g,
  ))
    links.push(m[1]);
  return links;
}

const routes = listRoutes(dir);
const problems = [];
let checked = 0;
for (const route of routes) {
  const html = read(resolveFile(route));
  for (const raw of extractLinks(html)) {
    if (!raw || /^(mailto|tel|data|javascript):/.test(raw)) continue;
    checked++;
    let u;
    try {
      u = new URL(raw, SITE + route);
    } catch {
      problems.push(`${route} → 无效 URL：${raw}`);
      continue;
    }
    if (u.origin !== SITE) continue;
    if (u.pathname !== '/' && !path.extname(u.pathname) && !u.pathname.endsWith('/')) {
      problems.push(`${route} → 缺少尾斜杠（会多一次 308）：${raw}`);
      continue;
    }
    const target = resolveFile(u.pathname);
    if (!target) {
      problems.push(`${route} → 404：${raw}`);
      continue;
    }
    if (u.hash && u.hash.length > 1 && target.endsWith('.html')) {
      const id = decodeURIComponent(u.hash.slice(1));
      if (!ids(read(target)).has(id)) problems.push(`${route} → 锚点不存在：${raw}`);
    }
  }
}
if (problems.length) {
  console.error(`✗ ${problems.length} 个坏链（共检查 ${checked} 个链接 / ${routes.length} 个页面）`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`✓ 无坏链：检查了 ${checked} 个链接 / ${routes.length} 个页面`);
