import art from '@/data/art.json';

/** 素材槽位 → 图片地址（用于在 <head> 里预加载首屏 LCP 图） */
export function artSrc(slot: string): string {
  const a = (art as Record<string, { src: string }>)[slot];
  if (!a) throw new Error(`未知素材槽位：${slot}`);
  return a.src;
}
