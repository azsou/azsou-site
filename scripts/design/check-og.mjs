/**
 * Q14 OG 检查（T9.4，DESIGN-SYSTEM §19.1）——构建后运行：
 *  - 每个可索引页面的 og:image 指向 dist 内存在的 1200×630 PNG，≤ 120 KB；og:image:alt 非空；
 *  - 详情页（应用 / AI 工具 / 游戏 / 视频 / 文章 / 作品 / 论坛种子帖，中英）用本页专属 OG，不落到栏目图；
 *  - meta description 长度（中文 50–80 字 / 英文 110–160 字符）只报告，不阻断（T9.5 / T9.6 收紧）。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DIST = 'dist/client';
const MAX = 120 * 1024;
const DETAIL = /^\/(en\/)?(apps|ai|games|videos|articles|works)\/[^/]+\/$|^\/forum\/t\/[^/]+\/$/;
const SKIP = /^\/(apps|ai|videos)\/(category|platform|page)\//;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'index.html') files.push(p);
  }
})(DIST);

const errors = [];
const descWarn = [];
const seen = new Map();
let pages = 0;
let dedicated = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  if (/<meta name="robots" content="noindex/.test(html)) continue;
  const route = '/' + path.relative(DIST, path.dirname(f)).replace(/\\/g, '/') + '/';
  const r = route === '//' ? '/' : route;
  const img = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  const alt = html.match(/<meta property="og:image:alt" content="([^"]*)"/)?.[1];
  pages++;
  if (!img) {
    errors.push(`${r}: 缺 og:image`);
    continue;
  }
  if (!alt) errors.push(`${r}: og:image:alt 为空`);
  const local = new URL(img).pathname;
  if (DETAIL.test(r) && !SKIP.test(r)) {
    if (local.startsWith('/og/s/') || !local.startsWith('/og/'))
      errors.push(`${r}: 详情页没有专属 OG（${local}）`);
    else dedicated++;
  }
  if (!seen.has(local)) {
    const file = path.join(DIST, local);
    if (!fs.existsSync(file)) seen.set(local, `不存在`);
    else {
      const size = fs.statSync(file).size;
      const m = await sharp(file).metadata();
      const bad = [];
      if (m.format !== 'png') bad.push(`格式 ${m.format}`);
      if (m.width !== 1200 || m.height !== 630) bad.push(`${m.width}×${m.height}`);
      if (size > MAX) bad.push(`${(size / 1024).toFixed(0)} KB > 120 KB`);
      seen.set(local, bad.join('，'));
    }
  }
  if (seen.get(local)) errors.push(`${r}: ${local} ${seen.get(local)}`);
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  const en = r.startsWith('/en/');
  const len = en ? desc.length : [...desc].reduce((a, c) => a + (c.charCodeAt(0) < 256 ? 0.5 : 1), 0);
  if (en ? len < 110 || len > 160 : len < 50 || len > 80) descWarn.push(`${r} ${Math.round(len)}`);
}
const sizes = [...seen.keys()]
  .filter((k) => fs.existsSync(path.join(DIST, k)))
  .map((k) => fs.statSync(path.join(DIST, k)).size);
const maxKb = Math.max(...sizes) / 1024;
const avgKb = sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024;
console.log(
  `OG：${pages} 个可索引页面，${seen.size} 张图（平均 ${avgKb.toFixed(1)} KB，最大 ${maxKb.toFixed(1)} KB），详情页专属 OG ${dedicated} 个`,
);
console.log(`报告：meta description 长度不在规范内 ${descWarn.length} 页（T9.5 / T9.6 收紧）`);
if (errors.length) {
  console.error(errors.slice(0, 40).join('\n'));
  console.error(`✗ OG 检查失败：${errors.length} 项`);
  process.exit(1);
}
// 媒体图体积（DESIGN-SYSTEM §19.3：单张 400–480w ≤ 120 KB）
const heavy = [];
let mediaMax = 0;
for (const dir of ['videos/thumbs', 'art']) {
  const d = path.join(DIST, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (dir === 'videos/thumbs' && !/-480\./.test(f)) continue;
    const size = fs.statSync(path.join(d, f)).size;
    mediaMax = Math.max(mediaMax, size);
    if (size > MAX) heavy.push(`${dir}/${f} ${(size / 1024).toFixed(0)} KB`);
  }
}
console.log(`媒体图（视频缩略图 480w / 生成式封面）最大 ${(mediaMax / 1024).toFixed(1)} KB`);
if (heavy.length) {
  console.error(heavy.join('\n'));
  console.error('✗ 媒体图超过 120 KB');
  process.exit(1);
}
console.log('✓ OG 检查通过');
