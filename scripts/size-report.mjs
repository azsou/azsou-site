#!/usr/bin/env node
/** 体积报告：每个路由首屏需要的 JS/CSS（gzip 后），并对照预算（首屏 JS < 50KB）。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { listRoutes } from './routes.mjs';

const dir = 'dist/client';
const BUDGET_JS = 50 * 1024;
const gz = (f) => zlib.gzipSync(fs.readFileSync(f)).length;
const file = (r) => path.join(dir, r.endsWith('/') ? r + 'index.html' : r);
const rows = [];
for (const r of listRoutes(dir)) {
  const html = fs.readFileSync(file(r), 'utf8');
  const js = new Set([...html.matchAll(/<script[^>]+src="(\/_astro\/[^"]+)"/g)].map((m) => m[1]));
  // 模块脚本的静态 import 也算首屏
  const queue = [...js];
  while (queue.length) {
    const src = fs.readFileSync(path.join(dir, queue.pop()), 'utf8');
    for (const m of src.matchAll(/(?:import|from)\s*["'](\.?\.?\/[^"']+\.js)["']/g)) {
      const p = path.posix.join('/_astro/', path.posix.basename(m[1]));
      if (!js.has(p)) {
        js.add(p);
        queue.push(p);
      }
    }
  }
  const css = [...html.matchAll(/<link[^>]+href="(\/_astro\/[^"]+\.css)"/g)].map((m) => m[1]);
  const inlineJs = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((m) => !m[0].includes('ld+json'))
    .reduce((n, m) => n + zlib.gzipSync(m[1]).length, 0);
  const jsBytes = [...js].reduce((n, s) => n + gz(path.join(dir, s)), 0) + inlineJs;
  const cssBytes = css.reduce((n, s) => n + gz(path.join(dir, s)), 0);
  rows.push({ route: r, html: gz(file(r)), js: jsBytes, css: cssBytes });
}
const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const max = (k) => rows.reduce((a, b) => (b[k] > a[k] ? b : a));
const total = fs
  .readdirSync(dir, { recursive: true })
  .map((f) => path.join(dir, f))
  .filter((f) => fs.statSync(f).isFile())
  .reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(
  JSON.stringify(
    {
      routes: rows.length,
      maxHtml: { route: max('html').route, gzip: kb(max('html').html) },
      maxJs: { route: max('js').route, gzip: kb(max('js').js) },
      maxCss: { route: max('css').route, gzip: kb(max('css').css) },
      totalDist: kb(total),
    },
    null,
    2,
  ),
);
const over = rows.filter((r) => r.js > BUDGET_JS);
if (over.length) {
  console.error('✗ 超出首屏 JS 预算：', over.map((r) => `${r.route} ${kb(r.js)}`).join(', '));
  process.exit(1);
}
console.log(`✓ 所有页面首屏 JS ≤ ${kb(BUDGET_JS)}（gzip）`);
