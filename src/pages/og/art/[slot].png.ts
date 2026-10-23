import type { APIRoute, GetStaticPaths } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import art from '@/data/art.json';

/**
 * 构建期把生成式 SVG 素材栅格化成 1200×675 PNG，用作 og:image
 * （微信、Facebook、X 等不接受 SVG 分享图）。
 */
export const getStaticPaths: GetStaticPaths = () => Object.keys(art).map((slot) => ({ params: { slot } }));

export const GET: APIRoute = ({ params }) => {
  const svg = fs.readFileSync(path.join(process.cwd(), 'public', 'art', `${params.slot}.svg`), 'utf8');
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    background: '#101014',
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
