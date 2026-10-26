/**
 * Q13 文案检查（T9.6，DESIGN-SYSTEM §18）——构建后扫描 dist/client 的可见文本：
 *  1. 禁用词（辩白式元叙述）：只允许出现在「关于」「编辑规范」（诚信原则各写一次）；
 *  2. 术语表「不用」列：应用商店 / 应用目录 / AI 工具库 / 站长 / 本站作者 / 自研应用；
 *  3. 可见文本里的 ISO 日期（2026-07-19）：日期统一走 lib/dates.ts（<time datetime> 属性不算）；
 *  4. 中文页面用「」不用 “ ”（英文原名 / 代码除外）；
 *  5. 英文页面可见文本里的中文（允许：语言切换「中文」、作品原名用 lang="zh" 标注的片段）。
 * 后台（/admin/）、组件目录（/_kit/）、CMS 不检查。用法：node scripts/design/copy-lint.mjs [--report]
 */
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist/client';
const REPORT = process.argv.includes('--report');

export const BANNED = [
  '不伪造',
  '不造假',
  '不刷',
  '真实计数',
  '真实下载',
  '如实标注',
  '非真实截图',
  '本站暂无足够',
  '不做热度',
  '测试环境',
];
const INTEGRITY_PAGES = new Set(['/about/', '/editorial/']);
export const TERMS = [
  ['应用商店', '应用'],
  ['应用目录', '应用'],
  ['AI 工具库', 'AI 工具'],
  ['站长', '作者'],
  ['本站作者', '作者'],
  ['自研应用', 'AZ Studio 出品'],
];
const SKIP = /^\/(admin|_kit|cms|og)\//;

function visibleText(html) {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
/** 去掉英文页里标注 lang="zh*" 的元素（含嵌套子元素），例如语言切换「中文」、作品原名 */
export function stripZhElements(html) {
  const re = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let out = '';
  let last = 0;
  let depth = 0; // >0 = 位于 lang=zh 元素内
  let m;
  while ((m = re.exec(html))) {
    const [tag, close, name, attrs] = m;
    const n = name.toLowerCase();
    const isVoid = VOID.has(n) || /\/\s*$/.test(attrs);
    if (depth === 0) {
      out += html.slice(last, m.index);
      if (!close && !isVoid && /\blang="zh/i.test(attrs)) depth = 1;
      else out += tag;
    } else if (!isVoid) {
      depth += close ? -1 : 1;
    }
    last = m.index + tag.length;
  }
  return out + html.slice(last);
}
function visibleTextEn(html) {
  return visibleText(
    stripZhElements(html.replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')),
  );
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) files.push(p);
  }
})(DIST);

const hits = { banned: [], terms: [], iso: [], quotes: [], en: [] };
const ctx = (t, i, n = 14) => t.slice(Math.max(0, i - n), i + n + 4).trim();
for (const f of files) {
  const route =
    '/' +
    path
      .relative(DIST, f)
      .replace(/\\/g, '/')
      .replace(/index\.html$/, '')
      .replace(/\.html$/, '');
  if (SKIP.test(route)) continue;
  const html = fs.readFileSync(f, 'utf8');
  if (/<meta name="robots" content="noindex/.test(html) && !route.startsWith('/404')) continue;
  const en = route.startsWith('/en/');
  const text = en ? visibleTextEn(html) : visibleText(html);
  if (!INTEGRITY_PAGES.has(route))
    for (const w of BANNED) {
      let i = text.indexOf(w);
      while (i >= 0) {
        hits.banned.push(`${route} 「${w}」… ${ctx(text, i)}`);
        i = text.indexOf(w, i + 1);
      }
    }
  for (const [bad, good] of TERMS) {
    const i = text.indexOf(bad);
    if (i >= 0) hits.terms.push(`${route} 「${bad}」→「${good}」… ${ctx(text, i)}`);
  }
  for (const m of text.matchAll(/(?<![\w/.-])20\d\d-[01]\d-[0-3]\d(?![\w/-])/g))
    hits.iso.push(`${route} ${m[0]} … ${ctx(text, m.index)}`);
  if (!en)
    for (const m of text.matchAll(/[“”][^“”]{0,30}[\u4e00-\u9fff][^“”]{0,30}[“”]/g))
      hits.quotes.push(`${route} ${m[0].slice(0, 30)}`);
  if (en) {
    const zh = text.replace(/中文/g, '').match(/[\u4e00-\u9fff][\u4e00-\u9fff\s，。、：「」（）]{0,20}/g);
    if (zh) hits.en.push(`${route} ${zh.length} 处：${zh.slice(0, 3).join(' / ')}`);
  }
}

const summary = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length]));
console.log(
  `文案检查：禁用词 ${summary.banned} · 术语 ${summary.terms} · 可见 ISO 日期 ${summary.iso} · 中文页直引号 ${summary.quotes} · 英文页中文 ${summary.en}`,
);
const fail = Object.values(summary).some((n) => n > 0);
if (fail || REPORT) {
  for (const [k, v] of Object.entries(hits))
    if (v.length) console.log(`\n[${k}]\n` + v.slice(0, REPORT ? 400 : 30).join('\n'));
}
if (fail && !REPORT) {
  console.error('\n✗ 文案检查失败（DESIGN-SYSTEM §18）');
  process.exit(1);
}
if (!fail) console.log('✓ 文案检查通过');
