/**
 * /ai/ 筛选 island：价格（分段按钮）+ 只看开源（复选框）。
 * 只切换已渲染卡片的 hidden，不重新渲染、不请求数据；状态写进查询串（replaceState，可分享）。
 * 打开带 ?price=…&oss=1 的地址时按查询串恢复。分类由页面本身决定（/ai/category/<分类>/ 是静态页）。
 */
import {
  PRICE_LABEL,
  filterTools,
  parseToolQuery,
  toolQueryString,
  type AiCategory,
  type PriceModel,
} from '@/lib/app-store';

const box = document.querySelector<HTMLElement>('[data-ai-filter]');
const grid = document.querySelector<HTMLElement>('[data-ai-grid]');
const statusEl = document.querySelector<HTMLElement>('[data-ai-status]');
const empty = document.querySelector<HTMLElement>('[data-ai-empty]');

interface Card {
  el: HTMLElement;
  price: PriceModel;
  openSource: boolean;
  categories: AiCategory[];
}

if (box && grid) {
  const cards: Card[] = [...grid.querySelectorAll<HTMLElement>('[data-tool]')].map((el) => ({
    el,
    price: el.dataset.price as PriceModel,
    openSource: el.dataset.oss === '1',
    categories: (el.dataset.cats ?? '').split(' ').filter(Boolean) as AiCategory[],
  }));
  const priceButtons = [...box.querySelectorAll<HTMLButtonElement>('[data-price]')];
  const oss = box.querySelector<HTMLInputElement>('[data-oss]')!;
  const initial = parseToolQuery(location.search);
  let state = { price: initial.price, oss: initial.oss };
  // 查询串里的价格在本页没有对应按钮（本页没有这种价格的工具）时忽略
  if (state.price && !priceButtons.some((b) => b.dataset.price === state.price)) state.price = '';

  const apply = (push: boolean) => {
    const shown = new Set(filterTools(cards, { price: state.price, oss: state.oss }).map((c) => c.el));
    for (const c of cards) c.el.hidden = !shown.has(c.el);
    for (const b of priceButtons)
      b.setAttribute('aria-pressed', String((b.dataset.price ?? '') === state.price));
    oss.checked = state.oss;
    const parts = [`共 ${shown.size} 个工具`];
    if (state.price) parts.push(PRICE_LABEL[state.price]);
    if (state.oss) parts.push('开源');
    if (statusEl) statusEl.textContent = `${parts.join(' · ')} · 只链接官方地址，本站不托管安装包`;
    if (empty) empty.hidden = shown.size > 0;
    if (push) history.replaceState(null, '', `${location.pathname}${toolQueryString(state)}${location.hash}`);
  };

  for (const b of priceButtons) {
    b.disabled = false;
    b.addEventListener('click', () => {
      state = { ...state, price: (b.dataset.price ?? '') as PriceModel | '' };
      apply(true);
    });
  }
  oss.disabled = false;
  oss.addEventListener('change', () => {
    state = { ...state, oss: oss.checked };
    apply(true);
  });
  box.dataset.ready = 'yes';
  if (state.price || state.oss) apply(false);
}
