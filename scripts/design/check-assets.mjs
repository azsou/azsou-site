#!/usr/bin/env node
/**
 * Q4 / Q18 资源检查（T9.3，DESIGN-QA §2.4 / §2.18），build 前运行，失败即阻断：
 *  - 图标规范化输出齐全、manifest 最新、主体占比 68%–76%（normalize-icons --check）
 *  - 站点图标：/favicon.ico、/favicon.svg（无 <text>，不依赖系统字体）、/apple-touch-icon.png 180、
 *    manifest 192 / 512 / maskable 512 + ≥ 4 个 shortcuts（各带 96 图标）+ 窄 / 宽 screenshots
 *  - 游戏 / 自研应用必须有图标或封面
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const problems = [];
try {
  execFileSync('node', ['scripts/design/normalize-icons.mjs', '--check'], { stdio: 'inherit' });
} catch {
  problems.push('图标规范化检查未通过（见上）');
}

const need = async (file, w, h) => {
  if (!existsSync(file)) return problems.push(`缺少 ${file}`);
  if (w) {
    const m = await sharp(file).metadata();
    if (m.width !== w || m.height !== h) problems.push(`${file} 尺寸 ${m.width}×${m.height}，应为 ${w}×${h}`);
  }
};
await need('public/favicon.ico');
await need('public/favicon.svg');
if (/<text[\s>]/.test(readFileSync('public/favicon.svg', 'utf8')))
  problems.push('favicon.svg 含 <text>（应转为路径）');
await need('public/apple-touch-icon.png', 180, 180);
const ico = readFileSync('public/favicon.ico');
if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) < 3) problems.push('favicon.ico 应含 16 / 32 / 48 三档');

const man = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
const has = (s, p) => man.icons.some((i) => i.sizes === s && (i.purpose ?? 'any') === p);
for (const [s, p] of [
  ['192x192', 'any'],
  ['512x512', 'any'],
  ['512x512', 'maskable'],
])
  if (!has(s, p)) problems.push(`manifest 缺 ${s} ${p} 图标`);
for (const i of man.icons)
  if (!i.src.endsWith('.svg')) await need(`public${i.src}`, ...i.sizes.split('x').map(Number));
if ((man.shortcuts ?? []).length < 4) problems.push('manifest shortcuts 少于 4 个');
for (const sc of man.shortcuts ?? []) for (const i of sc.icons ?? []) await need(`public${i.src}`, 96, 96);
for (const ff of ['narrow', 'wide']) {
  const s = (man.screenshots ?? []).find((x) => x.form_factor === ff);
  if (!s) problems.push(`manifest 缺 ${ff} screenshot`);
  else await need(`public${s.src}`, ...s.sizes.split('x').map(Number));
}

// 自研应用：图标必填（阻断）；游戏：缺封面时用 hue 渐变 + 几何图形兜底，只报告（真实封面待 T9.0 外包交付）
const missing = (dir) =>
  readdirSync(dir)
    .filter((x) => /\.(md|mdx|json)$/.test(x))
    .filter((f) => !/"?(icon|cover|thumbnail)"?\s*:/.test(readFileSync(`${dir}/${f}`, 'utf8')));
for (const f of missing('src/content/apps')) problems.push(`src/content/apps/${f}：自研应用缺图标`);
const games = missing('src/content/games');
if (games.length) console.warn(`报告：${games.length} 个游戏缺封面，使用兜底封面（${games.join(', ')}）`);

for (const p of problems) console.error('✗ ' + p);
if (!problems.length) console.log('✓ 资源检查通过（图标规范化、站点图标、manifest、游戏 / 应用图标）');
process.exit(problems.length ? 1 : 0);
