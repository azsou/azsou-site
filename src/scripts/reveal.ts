/**
 * 滚动渐显（P10i）：只给「当前视口下方」的区块 / 卡片加 data-reveal，进入视口时去掉 → CSS 过渡淡入 + 上移 12px；
 * 同一父级里的兄弟元素按序号错开 40ms（CSS nth-child，最多 6 级）。
 *  - 首屏元素从不隐藏：不影响 LCP，也不会闪烁；只改 opacity / translate：不产生布局偏移（CLS 0）；
 *  - prefers-reduced-motion: reduce、没有 IntersectionObserver、打印时什么都不做（CSS 也只在 no-preference 下生效）；
 *  - CSP 安全：不写内联样式，只切换属性。
 */
const SELECTOR = [
  'main .shelf',
  'main .bento-tile',
  'main .card',
  'main .list-items > li',
  'main .detail-main > section',
  'main .drawer__section',
].join(',');

export function initReveal(root: ParentNode = document) {
  if (typeof IntersectionObserver === 'undefined') return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fold = innerHeight;
  const els = [...root.querySelectorAll<HTMLElement>(SELECTOR)].filter((el) => {
    if (el.closest('[data-reveal]')) return false; // 外层已经在渐显，里面不再叠加
    const r = el.getBoundingClientRect();
    return r.top > fold && r.height > 0;
  });
  if (!els.length) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        io.unobserve(el);
        el.setAttribute('data-revealing', '');
        el.removeAttribute('data-reveal');
        const done = () => el.removeAttribute('data-revealing');
        el.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 700);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of els) {
    el.setAttribute('data-reveal', '');
    io.observe(el);
  }
  // 跳到锚点 / 打印前：全部立即显示
  const showAll = () => {
    for (const el of els) el.removeAttribute('data-reveal');
    io.disconnect();
  };
  addEventListener('beforeprint', showAll, { once: true });
  addEventListener('hashchange', showAll, { once: true });
}
