import type { APIRoute, GetStaticPaths } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import art from '@/data/art.json';
import { loadArtFonts, renderArtSvg } from '@/lib/og-art-render';

/**
 * 构建期把生成式 SVG 素材栅格化成 1200×675 PNG，用作 og:image
 * （微信、Facebook、X 等不接受 SVG 分享图）。
 * 字体只用 assets/og-fonts 的受控子集（不加载系统字体），渲染与字体检查见 src/lib/og-art-render.ts；
 * 槽位名传入渲染函数，只用于判定 800→700 批准例外（work-3 / work-7 / work-15 的 13px「!」）。
 */
export const getStaticPaths: GetStaticPaths = () => Object.keys(art).map((slot) => ({ params: { slot } }));

const fonts = loadArtFonts();

export const GET: APIRoute = ({ params }) => {
  const svg = fs.readFileSync(path.join(process.cwd(), 'public', 'art', `${params.slot}.svg`), 'utf8');
  const { png } = renderArtSvg(svg, fonts, { slot: params.slot });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
