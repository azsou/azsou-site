/**
 * 按页面类型生成 OG 分享图（T9.4，DESIGN-SYSTEM §19.1）：1200×630，构建期 SVG → resvg → sharp 调色板 PNG。
 * 字体用仓库内的 Noto Sans SC 子集（assets/og-fonts，scripts/design/og-font-subset.py 生成），不依赖构建机系统字体。
 * 只在构建期（src/pages/og/[...slug].png.ts）调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

export const OG_W = 1200;
export const OG_H = 630;
const PAD = 60;
const ROOT = process.cwd();
const FONT_DIR = path.join(ROOT, 'assets', 'og-fonts');
const FONT_FILES = ['NotoSansSC-Regular.subset.otf', 'NotoSansSC-Bold.subset.otf'].map((f) =>
  path.join(FONT_DIR, f),
);
const FAMILY = 'Noto Sans SC';

type Theme = { bg: string; label: string; label2: string; accent: string; plate: string };
const LIGHT: Theme = {
  bg: '#f5f5f7',
  label: '#1d1d1f',
  label2: '#55555c',
  accent: '#2f7d4f',
  plate: '#ffffff',
};
const DARK: Theme = {
  bg: '#1c1c1e',
  label: '#f5f5f7',
  label2: '#b4b4bb',
  accent: '#3fb56c',
  plate: '#2c2c2e',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 字宽估算（em）：汉字 / 全角 = 1，拉丁按常见字形宽度 */
function charW(c: string): number {
  if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f「」『』（），。、；：？！…—]/.test(c)) return 1;
  if (c === ' ') return 0.26;
  if (/[A-Z]/.test(c)) return /[MW]/.test(c) ? 0.86 : 0.64;
  if (/[a-z]/.test(c)) return /[mw]/.test(c) ? 0.82 : /[ijlft]/.test(c) ? 0.3 : 0.54;
  if (/[0-9]/.test(c)) return 0.56;
  return 0.4;
}
export const textW = (s: string, size: number) => [...s].reduce((a, c) => a + charW(c), 0) * size;

/** 断行：拉丁单词 / 数字+量词不拆，行首不放「，。、」）」等 */
export function wrap(text: string, size: number, width: number, maxLines: number): string[] {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9.+#\-_/:']*\s*(?:[个行分钟秒次件]\s*)?|\s+|./gu) ?? [];
  const lines: string[] = [];
  let cur = '';
  for (const t of tokens) {
    if (textW(cur + t.trimEnd(), size) <= width || !cur.trim()) {
      cur += t;
      continue;
    }
    if (/^[，。、；：？！」』）》…]/.test(t)) {
      cur += t;
      continue;
    }
    lines.push(cur.trimEnd());
    cur = t.trimStart();
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && textW(last + '…', size) > width) last = [...last].slice(0, -1).join('');
    kept[maxLines - 1] = last.trimEnd() + '…';
    return kept;
  }
  return lines;
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  size: number,
  weight: number,
  fill: string,
  lh = 1.25,
) {
  return lines
    .map(
      (l, i) =>
        `<text x="${x}" y="${y + i * size * lh}" font-family="${FAMILY}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(l)}</text>`,
    )
    .join('');
}

const LOGO = (t: Theme) =>
  `<g transform="translate(${PAD} ${PAD}) scale(${40 / 64})"><rect x="2" y="2" width="60" height="60" rx="14" fill="${t.accent}"/><g fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 43 21 21l8.5 22M15.8 35.5h10.4"/><path d="M35 21.5h16L35 42.5h16"/></g></g>` +
  `<text x="${PAD + 54}" y="${PAD + 29}" font-family="${FAMILY}" font-size="26" font-weight="700" fill="${t.label}">AZ Studio</text>`;

const frame = (t: Theme, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}"><rect width="${OG_W}" height="${OG_H}" fill="${t.bg}"/>${LOGO(t)}${body}<rect y="${OG_H - 8}" width="${OG_W}" height="8" fill="${t.accent}"/></svg>`;

/** public/ 下的图片 → data URI（webp / avif 先转 PNG，resvg 只认 PNG / JPEG / SVG） */
async function dataUri(publicPath: string, w?: number): Promise<string | null> {
  const file = path.join(ROOT, 'public', publicPath.replace(/^\//, ''));
  if (!fs.existsSync(file)) return null;
  if (file.endsWith('.svg')) return `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
  let img = sharp(file);
  if (w) img = img.resize({ width: w, withoutEnlargement: false });
  const png = await img.png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 规范化后的图标母版（public/<dir>/n/<slug>.png，T9.3）；没有就用原图 */
function iconFile(src: string): string {
  const n = src.replace(/\/([^/]+)\.(png|webp|svg)$/, '/n/$1.png');
  return fs.existsSync(path.join(ROOT, 'public', n.slice(1))) ? n : src;
}

async function squircleIcon(src: string, x: number, y: number, size: number, plate: string, id: string) {
  const uri = await dataUri(iconFile(src), size * 2);
  const r = size * 0.225;
  const clip = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath>`;
  const img = uri
    ? `<image x="${x}" y="${y}" width="${size}" height="${size}" xlink:href="${uri}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
    : '';
  return `<defs>${clip}</defs><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${plate}"/>${img}<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none" stroke="rgba(0,0,0,.08)"/>`;
}

async function cover(src: string, x: number, y: number, w: number, h: number, id: string, bg: string) {
  const uri = await dataUri(src, w * 2 > 1600 ? 1600 : w * 2);
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20"/></clipPath></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${bg}"/>${
    uri
      ? `<image x="${x}" y="${y}" width="${w}" height="${h}" xlink:href="${uri}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
      : ''
  }`;
}

export type OgSpec =
  | { kind: 'app'; title: string; tagline: string; meta: string; icon: string; dark?: boolean }
  | { kind: 'cover'; title: string; tagline?: string; meta: string; image: string; dark?: boolean }
  | { kind: 'article'; title: string; meta: string; eyebrow?: string; dark?: boolean }
  | { kind: 'section'; title: string; tagline: string; icons: string[]; dark?: boolean };

export async function ogSvg(spec: OgSpec): Promise<string> {
  const t = spec.dark ? DARK : LIGHT;
  if (spec.kind === 'app') {
    const s = 200;
    const top = 215;
    const tx = PAD + s + 48;
    const tw = OG_W - tx - PAD;
    const title = wrap(spec.title, 64, tw, 2);
    const tag = wrap(spec.tagline, 32, tw, 1);
    const y0 = top + 56 + (title.length === 1 ? 20 : 0);
    const after = y0 + (title.length - 1) * 80;
    return frame(
      t,
      (await squircleIcon(spec.icon, PAD, top, s, t.plate, 'ic')) +
        textBlock(title, tx, y0, 64, 700, t.label) +
        textBlock(tag, tx, after + 56, 32, 400, t.label2) +
        textBlock([spec.meta], tx, after + 112, 26, 400, t.accent),
    );
  }
  if (spec.kind === 'cover') {
    const w = 640;
    const h = 360;
    const top = 150;
    const tx = PAD + w + 44;
    const tw = OG_W - tx - PAD;
    const title = wrap(spec.title, 44, tw, 4);
    const tag = spec.tagline ? wrap(spec.tagline, 26, tw, 2) : [];
    let y = top + 44;
    let body =
      (await cover(spec.image, PAD, top, w, h, 'cv', t.plate)) + textBlock(title, tx, y, 44, 700, t.label);
    y += title.length * 56 + 12;
    if (tag.length) {
      body += textBlock(tag, tx, y, 26, 400, t.label2, 1.4);
      y += tag.length * 36 + 12;
    }
    body += textBlock(wrap(spec.meta, 24, tw, 2), tx, y + 4, 24, 400, t.accent, 1.4);
    return frame(t, body);
  }
  if (spec.kind === 'article') {
    const tw = OG_W - PAD * 2;
    const title = wrap(spec.title, 64, tw, 3);
    const blockH = title.length * 82;
    const y0 = 160 + (3 - title.length) * 30 + 64;
    let body = '';
    if (spec.eyebrow) body += textBlock([spec.eyebrow], PAD, y0 - 92, 28, 600, t.accent);
    body += textBlock(title, PAD, y0, 64, 700, t.label, 1.28);
    body += textBlock([spec.meta], PAD, y0 + blockH + 10, 30, 400, t.label2);
    return frame(t, body);
  }
  // section
  const title = wrap(spec.title, 80, OG_W - PAD * 2, 1);
  const tag = wrap(spec.tagline, 34, OG_W - PAD * 2, 2);
  let body = textBlock(title, PAD, 250, 80, 700, t.label) + textBlock(tag, PAD, 320, 34, 400, t.label2, 1.4);
  const s = 112;
  const gap = 28;
  const icons = spec.icons.slice(0, 4);
  for (let i = 0; i < icons.length; i++) {
    body += await squircleIcon(icons[i], PAD + i * (s + gap), OG_H - PAD - 8 - s - 10, s, t.plate, `s${i}`);
  }
  return frame(t, body);
}

export async function ogPng(spec: OgSpec): Promise<Buffer> {
  const svg = await ogSvg(spec);
  const raw = new Resvg(svg, {
    fitTo: { mode: 'width', value: OG_W },
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: FAMILY },
    imageRendering: 0,
  })
    .render()
    .asPng();
  // 调色板量化：扁平底 + 文字 + 小图，128 色足够（含照片缩略图的视频模板也能控制在预算内）；控制在 120 KB 内
  const out = await sharp(raw)
    .png({ palette: true, quality: 85, colours: 128, effort: 10, compressionLevel: 9 })
    .toBuffer();
  return out;
}
