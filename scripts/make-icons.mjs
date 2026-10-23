#!/usr/bin/env node
/** 从 public/favicon.svg 生成 PWA PNG 图标（一次性，产物已提交）。依赖 @resvg/resvg-js。 */
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
const dir = 'public/icons';
fs.mkdirSync(dir, { recursive: true });
// resvg 不支持 oklch，换成等价 sRGB；文字用系统无衬线字体
const base = fs.readFileSync('public/favicon.svg', 'utf8').replace('oklch(49% .14 145)', '#2f7d4f');
const full = base.replace('<rect x="2" y="2" width="60" height="60" rx="14"', '<rect x="0" y="0" width="64" height="64" rx="14"');
const maskable = base
  .replace(/<rect[^>]*\/>/, '<rect x="0" y="0" width="64" height="64" fill="#2f7d4f"/>')
  .replace('font-size="24"', 'font-size="18"')
  .replace('y="41"', 'y="38"');
const render = (svg, size, file) => {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  })
    .render()
    .asPng();
  fs.writeFileSync(`${dir}/${file}`, png);
  console.log(file, png.length);
};
render(full, 192, 'icon-192.png');
render(full, 512, 'icon-512.png');
render(maskable, 512, 'icon-maskable-512.png');
render(full.replace('rx="14"', 'rx="0"'), 180, 'apple-touch-icon.png');
