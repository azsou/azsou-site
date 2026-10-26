/**
 * 应用 / 工具图标（T9.3，DESIGN-SYSTEM §6）：5 档容器尺寸，规范化后的多尺寸版本由
 * scripts/design/normalize-icons.mjs 生成在母版同目录的 n/ 下：<dir>/n/<slug>-<px>.{avif,webp}，
 * px ∈ 32 / 40 / 56 / 64 / 72 / 80 / 112 / 144 / 224（每档 ×1 / ×2）。分类与底色见 src/data/icon-manifest.json。
 */
import manifest from '@/data/icon-manifest.json';

export const ICON_PX = { xs: 32, sm: 40, md: 56, lg: 72, xl: 112 } as const;
export type IconSize = keyof typeof ICON_PX;

export type IconClass = 'light' | 'transparent' | 'dark' | 'colored' | 'full-bleed';
type Entry = { class: IconClass; bg: string; fullBleed: boolean };
const M = manifest as Record<string, Entry>;

const slugOf = (src: string) => src.replace(/^.*\//, '').replace(/\.(png|svg|webp)$/, '');
const normBase = (src: string) => `${src.replace(/\/[^/]+$/, '')}/n/${slugOf(src)}`;

/** 母版是否有规范化输出（manifest 里有记录） */
export const iconInfo = (src: string): Entry | undefined => M[slugOf(src)];

export function iconSrcset(src: string, size: IconSize, ext: 'avif' | 'webp'): string {
  const px = ICON_PX[size];
  const base = normBase(src);
  return `${base}-${px}.${ext} 1x, ${base}-${px * 2}.${ext} 2x`;
}

export function iconFallbackSrc(src: string, size: IconSize): string {
  return `${normBase(src)}-${ICON_PX[size] * 2}.webp`;
}
