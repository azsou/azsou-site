/**
 * 图标加载失败兜底（T9.3，DESIGN-SYSTEM §19.3）：.app-icon-img 出错时去掉 alt（不露文本）、
 * 停止重试，标记 data-broken —— CSS 用条目色相渐变 + 几何图形画出兜底，不出现裂图。
 * 捕获阶段监听 error（img 的 error 不冒泡）；脚本加载前已失败的图片在初始化时补处理。
 */
import { geoIconSvg } from '@/lib/geo-icon';

function fallback(img: HTMLImageElement) {
  if (img.dataset.broken != null) return;
  img.dataset.broken = '';
  img.alt = '';
  img.removeAttribute('srcset');
  img
    .closest('picture')
    ?.querySelectorAll('source')
    .forEach((s) => s.remove());
  const seed = img.currentSrc || img.src;
  img.src = `data:image/svg+xml,${encodeURIComponent(geoIconSvg(seed).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}`;
}

export function initIconFallback() {
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.classList.contains('app-icon-img')) fallback(t);
    },
    true,
  );
  for (const img of document.querySelectorAll<HTMLImageElement>('img.app-icon-img')) {
    if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) fallback(img);
  }
}
