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
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = track.scrollWidth - track.clientWidth;
      const atStart = track.scrollLeft <= 2;
      const atEnd = track.scrollLeft >= max - 2;
      // 边缘渐隐：到头的一侧不渐隐（DESIGN-SYSTEM §9）
      track.toggleAttribute('data-at-start', atStart);
      track.toggleAttribute('data-at-end', atEnd);
      if (!ctl) return;
      ctl.hidden = max <= 4;
      for (const b of btns) b.disabled = Number(b.dataset.dir) < 0 ? atStart : atEnd;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // 每次滚动一屏：整数张（容器宽减去露出的 48px），scroll-snap 对齐到卡片起点
    const page = () => {
      const peek = parseFloat(getComputedStyle(track).getPropertyValue('--peek')) || 48;
      return Math.max(track.clientWidth - peek * 2, track.clientWidth * 0.5);
    };
    for (const b of btns)
      b.addEventListener('click', () => {
        track.scrollBy({
          left: Number(b.dataset.dir) * page(),
          behavior: reduce.matches ? 'auto' : 'smooth',
        });
      });
    // 键盘：Tab 到行内条目时把它滚进可见区（只横向，不跳页面）
    track.addEventListener('focusin', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li && li.parentElement === track)
        li.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: reduce.matches ? 'auto' : 'smooth',
        });
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

/**
 * 最近更新的相对时间（DESIGN-SYSTEM §12）：< 7 天「3 天前」，< 1 年「3 个月前」，更早保留绝对日期；
 * 构建期输出绝对日期（无 JS 时可读），title 里始终是绝对日期。
 */
export function initRelativeTimes(root: ParentNode = document, now = Date.now()) {
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'zh-CN', { numeric: 'auto' });
  for (const el of root.querySelectorAll<HTMLTimeElement>('time[data-relative]')) {
    const t = Date.parse(el.dateTime);
    if (Number.isNaN(t)) continue;
    const days = Math.floor((now - t) / 86_400_000);
    if (days < 0 || days >= 365) continue;
    el.textContent =
      days < 7
        ? rtf.format(-days, 'day')
        : days < 30
          ? rtf.format(-Math.floor(days / 7), 'week')
          : rtf.format(-Math.floor(days / 30), 'month');
  }
}
