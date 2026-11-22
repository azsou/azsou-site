#!/usr/bin/env node
/**
 * 图标规范化管线（T9.3，DESIGN-SYSTEM §6.2–6.3，DESIGN-QA Q4）。
 * 输入：public/ai/icons/<slug>.png（第三方工具）、public/apps/icons/<slug>.png（自研应用）。
 * 处理：
 *   1. 底色分类：取四边像素 → 均匀且 L* > 92 = light；alpha 低 = transparent；L* < 12 = dark；
 *      其它均匀色 = colored；边缘不均匀（插画 / 渐变满幅，自研应用）= full-bleed（只做安全区校验，不改）。
 *   2. 去底找主体外接框（与底色差 > 阈值的像素），按 §6.2 缩放到画布的 72%（落在 68%–76%），
 *      放回原底色（light / transparent 放到白色垫板）。
 *   3. 输出 <dir>/n/<slug>-{32,40,56,64,72,80,112,144,224}.{avif,webp} 与 <dir>/n/<slug>.png（256 母版，OG 用）。
 *   4. 写 src/data/icon-manifest.json：分类、底色、处理前后主体占比、源图尺寸。
 * 用法：node scripts/design/normalize-icons.mjs [--check]
 *   --check：只校验（manifest 与输出齐全、占比合规、源图尺寸），不写文件；CI 的 check:assets 调用。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SIZES = [32, 40, 56, 64, 72, 80, 112, 144, 224];
export const SOURCES = [
  { dir: 'public/ai/icons', kind: 'tool' },
  { dir: 'public/apps/icons', kind: 'app' },
];
const TARGET = 0.72;
const MIN = 0.68;
const MAX = 0.76;
const MANIFEST = resolve(ROOT, 'src/data/icon-manifest.json');

const lstar = ([r, g, b]) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 读 RGBA，分类并找主体外接框 */
export async function analyze(file) {
  const img = sharp(file).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const px = (x, y) => {
    const i = (y * W + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  // 四边（向内 2px，避开抗锯齿边）
  const border = [];
  for (let x = 2; x < W - 2; x += 2) border.push(px(x, 2), px(x, H - 3));
  for (let y = 2; y < H - 2; y += 2) border.push(px(2, y), px(W - 3, y));
  const transparentEdge = border.filter((p) => p[3] < 25).length / border.length > 0.6;
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const uniform = border.filter((p) => dist(p, med) < 28).length / border.length;
  let cls;
  if (transparentEdge) cls = 'transparent';
  else if (uniform < 0.85) cls = 'full-bleed';
  else if (lstar(med) > 92) cls = 'light';
  else if (lstar(med) < 12) cls = 'dark';
  else cls = 'colored';
  // 主体外接框
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = px(x, y);
      const fg = cls === 'transparent' ? p[3] > 40 : p[3] > 40 && dist(p, med) > 48;
      if (fg) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  const bbox = x1 < 0 ? { x: 0, y: 0, w: W, h: H } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const ratio = cls === 'full-bleed' ? 1 : Math.max(bbox.w, bbox.h) / Math.max(W, H);
  const bg = cls === 'light' || cls === 'transparent' ? [255, 255, 255] : med;
  return { W, H, cls, bg, bbox, ratio, uniform: +uniform.toFixed(2) };
}

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** 生成 256 母版：主体缩放到 72% 居中，放在底色上 */
async function master(file, a) {
  const S = 256;
  if (a.cls === 'full-bleed') return sharp(file).resize(S, S, { fit: 'cover' }).png().toBuffer();
  const side = Math.round(S * TARGET);
  const scale = side / Math.max(a.bbox.w, a.bbox.h);
  const w = Math.max(1, Math.round(a.bbox.w * scale));
  const h = Math.max(1, Math.round(a.bbox.h * scale));
  // 主体区域：去掉底色（透明化），避免把源图的白边 / 黑边一起放大
  const sub = await sharp(file)
    .ensureAlpha()
    .extract({ left: a.bbox.x, top: a.bbox.y, width: a.bbox.w, height: a.bbox.h })
    .resize(w, h, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const [r, g, b] = a.bg.map(Math.round);
  return sharp({ create: { width: S, height: S, channels: 4, background: { r, g, b, alpha: 1 } } })
    .composite([{ input: sub, left: Math.round((S - w) / 2), top: Math.round((S - h) / 2) }])
    .png()
    .toBuffer();
}

export function variantPath(dir, slug, px, ext) {
  return `${dir}/n/${slug}-${px}.${ext}`;
}

async function run(check) {
  const manifest = {};
  const problems = [];
  const lowRes = [];
  for (const { dir, kind } of SOURCES) {
    const abs = resolve(ROOT, dir);
    for (const f of readdirSync(abs).filter((x) => x.endsWith('.png'))) {
      const slug = basename(f, '.png');
      const file = resolve(abs, f);
      const a = await analyze(file);
      const outDir = resolve(abs, 'n');
      let after = a.ratio;
      if (!check) {
        mkdirSync(outDir, { recursive: true });
        const m = await master(file, a);
        writeFileSync(resolve(outDir, `${slug}.png`), m);
        for (const px of SIZES) {
          const base = sharp(m).resize(px, px, { kernel: 'lanczos3' });
          writeFileSync(
            resolve(outDir, `${slug}-${px}.avif`),
            await base.clone().avif({ quality: 60, effort: 6 }).toBuffer(),
          );
          writeFileSync(
            resolve(outDir, `${slug}-${px}.webp`),
            await base.clone().webp({ quality: 82 }).toBuffer(),
          );
        }
        after = a.cls === 'full-bleed' ? 1 : (await analyze(resolve(outDir, `${slug}.png`))).ratio;
      } else {
        const p = resolve(outDir, `${slug}.png`);
        if (!existsSync(p)) problems.push(`${dir}/${f}：缺规范化输出（运行 npm run icons）`);
        else after = a.cls === 'full-bleed' ? 1 : (await analyze(p)).ratio;
        for (const px of SIZES)
          for (const ext of ['avif', 'webp'])
            if (!existsSync(resolve(outDir, `${slug}-${px}.${ext}`)))
              problems.push(`缺 ${dir}/n/${slug}-${px}.${ext}`);
      }
      const fullBleed = a.cls === 'full-bleed';
      if (!fullBleed && (after < MIN || after > MAX))
        problems.push(`${slug}：主体占比 ${(after * 100).toFixed(1)}% 不在 68%–76%`);
      // 源图尺寸：自研应用 1024 阻断；第三方要求 512，现有官方图标多为 256 —— 只报告（待 T9.0 / 站长补高清源）
      if (kind === 'app' && a.W < 1024) problems.push(`${slug}：自研应用源图 ${a.W}px < 1024px`);
      if (kind === 'tool' && a.W < 512) lowRes.push(slug);
      manifest[slug] = {
        kind,
        dir: '/' + dir.replace(/^public\//, ''),
        class: a.cls,
        bg: hex(a.bg),
        source: a.W,
        ratioBefore: +a.ratio.toFixed(3),
        ratioAfter: +after.toFixed(3),
        fullBleed,
      };
    }
  }
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    const cur = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '';
    if (cur !== json) problems.push('src/data/icon-manifest.json 过期（运行 npm run icons）');
  } else writeFileSync(MANIFEST, json);
  const rows = Object.entries(manifest);
  const ok = rows.filter(([, m]) => m.fullBleed || (m.ratioAfter >= MIN && m.ratioAfter <= MAX)).length;
  console.log(
    `图标 ${rows.length} 个；安全区合规 ${ok}/${rows.length}；分类 ${JSON.stringify(rows.reduce((o, [, m]) => ((o[m.class] = (o[m.class] || 0) + 1), o), {}))}`,
  );
  if (lowRes.length) console.warn(`报告：${lowRes.length} 个第三方图标源图 < 512px（${lowRes.join(', ')}）`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = await run(process.argv.includes('--check'));
  for (const p of problems) console.error('✗ ' + p);
  process.exit(problems.length ? 1 : 0);
}
