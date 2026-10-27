/**
 * D02 / T007：构建产物里没有「用了却没定义」的 CSS 自定义属性。
 * 扫描 dist/client 下全部 CSS、HTML 内联 <style> / style="" 与客户端 JS 里的 setProperty('--x')。
 * 只检查没有回退值的 var(--x)；带回退值的 var(--x, …) 是有意为之（例如组件可选参数）。
 * 需要先 npm run build。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist/client';
/** 不扫描的目录：/cms/ 是第三方 Decap 外壳；/pagefind/ 是检索索引分片；/og/ 只有图片（目录多，遍历慢） */
const SKIP = new Set(['cms', 'pagefind', 'og']);
/** 一次遍历按扩展名分组（原先 css / html / js 各遍历一遍，慢盘上 3 次目录遍历就占了大半耗时） */
function walk(dir: string, out: Record<string, string[]> = { '.css': [], '.html': [], '.js': [] }) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(path.relative(ROOT, p))) walk(p, out);
      continue;
    }
    out[path.extname(e.name)]?.push(p);
  }
  return out;
}

/** 运行时由脚本或浏览器注入、构建期看不到定义的变量（白名单需写明来源） */
const RUNTIME_ALLOW = new Set<string>([]);

function collect() {
  const defined = new Set<string>();
  const used = new Map<string, Set<string>>();
  const addUse = (name: string, file: string) => {
    if (!used.has(name)) used.set(name, new Set());
    used.get(name)!.add(path.relative(ROOT, file));
  };
  const scanCss = (css: string, file: string) => {
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) if (m[2] === ')') addUse(m[1], file);
  };
  const files = walk(ROOT);
  for (const f of files['.css']) scanCss(fs.readFileSync(f, 'utf8'), f);
  for (const f of files['.html']) {
    const html = fs.readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) scanCss(m[1], f);
    for (const m of html.matchAll(/style="([^"]*)"/g)) scanCss(m[1].replace(/&#39;|&quot;/g, "'"), f);
  }
  for (const f of files['.js']) {
    const js = fs.readFileSync(f, 'utf8');
    for (const m of js.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) defined.add(m[1]);
    for (const m of js.matchAll(/["'`;{ ](--[\w-]+):/g)) defined.add(m[1]);
  }
  return { defined, used };
}

describe('D02 / T007 设计令牌', () => {
  it('构建产物没有未定义的 CSS 变量（无回退值的 var() 引用都有定义）', { timeout: 60_000 }, () => {
    const { defined, used } = collect();
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used]
      .filter(([name]) => !defined.has(name) && !RUNTIME_ALLOW.has(name))
      .map(([name, files]) => `${name} ← ${[...files].slice(0, 3).join(', ')}`);
    expect(missing).toEqual([]);
  });
});
