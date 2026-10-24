/**
 * 应用 / 工具图标的多尺寸版本（scripts/icons/render.mjs 生成）：<base>-{64,128,256}.{avif,webp}。
 * 1x / 2x 按显示尺寸挑选：40 / 64 px → 64 + 128；120 px → 128 + 256。
 */
export const ICON_PX = { sm: 40, md: 64, lg: 120 } as const;
export type IconSize = keyof typeof ICON_PX;

export function iconSrcset(src: string, size: IconSize, ext: 'avif' | 'webp'): string {
  const base = src.replace(/\.(png|svg|webp)$/, '');
  const [x1, x2] = size === 'lg' ? [128, 256] : [64, 128];
  return `${base}-${x1}.${ext} 1x, ${base}-${x2}.${ext} 2x`;
}
