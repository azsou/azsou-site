/**
 * 「更多筛选」弹层（src/components/ui/MoreFilters.astro）的小助手：
 * - setMoreFiltersCount：摘要上显示生效的次要条件数（0 时隐藏），读屏同时读到「更多筛选 2」；
 * - initMoreFilters：Esc 关闭并把焦点还给摘要；点弹层外部关闭。只初始化一次。
 */
export function setMoreFiltersCount(root: ParentNode, n: number) {
  const badge = root.querySelector<HTMLElement>('[data-more-filters-n]');
  if (!badge) return;
  badge.textContent = n > 0 ? String(n) : '';
  badge.hidden = n === 0;
}

export function initMoreFilters(doc: Document = document) {
  for (const d of doc.querySelectorAll<HTMLDetailsElement>('[data-more-filters]')) {
    if (d.dataset.moreReady) continue;
    d.dataset.moreReady = 'yes';
    const summary = d.querySelector('summary');
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && d.open) {
        d.open = false;
        summary?.focus();
      }
    });
    doc.addEventListener('click', (e) => {
      if (d.open && e.target instanceof Node && !d.contains(e.target)) d.open = false;
    });
  }
}
