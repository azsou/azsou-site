/**
 * /videos/ 筛选 island：时长（分段按钮）+ 频道（下拉）。
 * 只切换已渲染卡片的 hidden，不重新渲染、不请求数据；状态写进查询串（replaceState，可分享）。
 * 打开带 ?len=…&ch=… 的地址时按查询串恢复。分类由页面本身决定（/videos/category/<分类>/ 是静态页）。
 */
import {
  LENGTH_LABEL,
  filterVideos,
  parseVideoQuery,
  videoQueryString,
  type VideoLength,
  type VideoQuery,
} from '@/lib/videos';
import { initMoreFilters, setMoreFiltersCount } from '@/scripts/more-filters';

const box = document.querySelector<HTMLElement>('[data-video-filter]');
const grid = document.querySelector<HTMLElement>('[data-video-grid]');
const statusEl = document.querySelector<HTMLElement>('[data-video-status]');
const empty = document.querySelector<HTMLElement>('[data-video-empty]');

if (box && grid) {
  const cards = [...grid.querySelectorAll<HTMLElement>('[data-video]')].map((el) => ({
    el,
    length: (el.dataset.len ?? '') as VideoLength | '',
    channel: el.dataset.ch ?? '',
  }));
  const lenButtons = [...box.querySelectorAll<HTMLButtonElement>('[data-len]')];
  const select = box.querySelector<HTMLSelectElement>('[data-ch]')!;
  const channelName = (k: string) => [...select.options].find((o) => o.value === k)?.textContent ?? k;
  let state: VideoQuery = parseVideoQuery(location.search);
  // 查询串里的值在本页没有对应选项时忽略
  if (state.len && !lenButtons.some((b) => b.dataset.len === state.len)) state.len = '';
  if (state.ch && ![...select.options].some((o) => o.value === state.ch)) state.ch = '';

  const more = box.closest<HTMLElement>('[data-more-filters]') ?? box;
  initMoreFilters();
  const apply = (push: boolean) => {
    const shown = new Set(filterVideos(cards, state).map((c) => c.el));
    for (const c of cards) c.el.hidden = !shown.has(c.el);
    for (const b of lenButtons) b.setAttribute('aria-pressed', String((b.dataset.len ?? '') === state.len));
    select.value = state.ch;
    const parts = [`共 ${shown.size} 个视频`];
    if (state.len) parts.push(LENGTH_LABEL[state.len]);
    if (state.ch) parts.push(channelName(state.ch));
    if (statusEl) statusEl.textContent = `${parts.join(' · ')} · 点击后才加载播放器`;
    if (empty) empty.hidden = shown.size > 0;
    setMoreFiltersCount(more, (state.len ? 1 : 0) + (state.ch ? 1 : 0));
    if (push)
      history.replaceState(null, '', `${location.pathname}${videoQueryString(state)}${location.hash}`);
  };

  for (const b of lenButtons) {
    b.disabled = false;
    b.addEventListener('click', () => {
      state = { ...state, len: (b.dataset.len ?? '') as VideoLength | '' };
      apply(true);
    });
  }
  select.disabled = false;
  select.addEventListener('change', () => {
    state = { ...state, ch: select.value };
    apply(true);
  });
  box.dataset.ready = 'yes';
  if (state.len || state.ch) apply(false);
}
