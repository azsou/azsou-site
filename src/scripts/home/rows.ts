/**
 * 首页横向滚动行的「上一组 / 下一组」按钮 + 快捷键提示（Ctrl/⌘K 打开全站搜索面板）。
 * - 按钮只在内容确实溢出时显示；到头 / 到尾时禁用。
 * - 减少动态效果（prefers-reduced-motion）时直接跳转，不做平滑滚动。
 * - 没有 JS 时行仍可原生滚动（触屏滑动、触控板、Shift+滚轮、聚焦后方向键）。
 */
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

export function initRows(root: ParentNode = document) {
  for (const track of root.querySelectorAll<HTMLElement>('[data-srow]')) {
    const btns = [...document.querySelectorAll<HTMLButtonElement>(`[aria-controls="${track.id}"]`)];
    const ctl = btns[0]?.closest<HTMLElement>('[data-srow-ctl]');
    if (!ctl) continue;
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = track.scrollWidth - track.clientWidth;
      ctl.hidden = max <= 4;
      for (const b of btns) {
        const dir = Number(b.dataset.dir);
        b.disabled = dir < 0 ? track.scrollLeft <= 2 : track.scrollLeft >= max - 2;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    for (const b of btns)
      b.addEventListener('click', () => {
        const dir = Number(b.dataset.dir);
        track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: reduce.matches ? 'auto' : 'smooth' });
      });
    track.addEventListener('scroll', schedule, { passive: true });
    new ResizeObserver(schedule).observe(track);
    update();
  }
}

/** Ctrl/⌘K 由全站外壳（site-shell.ts）打开搜索面板；这里只把提示里的 Ctrl 在苹果设备上换成 ⌘ */
export function initSearchShortcut() {
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const kbd = document.querySelector<HTMLElement>('[data-kbd-mod]');
  if (kbd && mac) kbd.textContent = '⌘';
}
