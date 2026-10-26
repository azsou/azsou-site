#!/usr/bin/env node
/**
 * 站点图标（T9.3，DESIGN-SYSTEM §19.2）：从 public/favicon.svg 生成全部 PNG / ICO（产物已提交，改 favicon 后重跑）。
 *  - favicon.svg：「AZ」是描边路径，不依赖系统字体；颜色用 hex
 *  - /favicon.ico（16 / 32 / 48，PNG 内嵌 ICO）
 *  - /apple-touch-icon.png 180（不透明、无圆角，iOS 自己裁切）
 *  - /icons/icon-192.png、icon-512.png、icon-maskable-512.png（主体在 80% 安全区内）
 *  - /icons/shortcut-{apps,ai,search,forum}.png 96（manifest shortcuts）
 * 依赖 @resvg/resvg-js、sharp。
 */
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const BRAND = '#2f7d4f';
const svg = fs.readFileSync('public/favicon.svg', 'utf8');
// 字形部分（<g> … </g>），用于重新排版到不同画布
const glyph = svg.match(/<g[\s\S]*<\/g>/)[0];

const render = (src, size) =>
  new Resvg(src, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

const frame = ({ rx, inset = 0, scale = 1 }) => {
  const t = 32 - 32 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="${inset}" y="${inset}" width="${64 - inset * 2}" height="${64 - inset * 2}" rx="${rx}" fill="${BRAND}"/><g transform="translate(${t} ${t}) scale(${scale})">${glyph}</g></svg>`;
};

const out = (file, buf) => {
  fs.writeFileSync(file, buf);
  console.log(file, buf.length);
};

fs.mkdirSync('public/icons', { recursive: true });
out('public/icons/icon-192.png', render(frame({ rx: 14 }), 192));
out('public/icons/icon-512.png', render(frame({ rx: 14 }), 512));
// maskable：满幅底色，字形缩到 80% 安全区内
out('public/icons/icon-maskable-512.png', render(frame({ rx: 0, scale: 0.8 }), 512));
out('public/apple-touch-icon.png', render(frame({ rx: 0 }), 180));
// 旧路径保留一份，已缓存的旧 HTML 仍可用
out('public/icons/apple-touch-icon.png', render(frame({ rx: 0 }), 180));

// favicon.ico：PNG 内嵌（Vista+ / 所有现代浏览器支持）
const ico = (pngs) => {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
};
out(
  'public/favicon.ico',
  ico([16, 32, 48].map((size) => ({ size, buf: render(frame({ rx: 14, inset: 2 }), size) }))),
);

// manifest shortcuts：品牌底 + Lucide 线性图标（ISC），白色描边
const LUCIDE = {
  apps: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  ai: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  forum: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
};
for (const [name, paths] of Object.entries(LUCIDE)) {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="21" fill="${BRAND}"/><g transform="translate(24 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
  out(`public/icons/shortcut-${name}.png`, render(s, 96));
}
