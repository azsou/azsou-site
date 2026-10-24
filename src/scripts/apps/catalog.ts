/**
 * 应用目录 island：筛选（平台 / 分类 / 价格）、排序（最新 / 热门 / 评分）、结果分页，状态写进 URL 查询串（可分享、可后退）。
 * 静态页是「最新」排序的第 N 页；只有用户改了筛选 / 排序（或打开带查询串的地址）时才接管列表。
 * 卡片上的评分 / 下载数一行：读真实统计（app_download_counts / app_review_stats），读不到就保持「暂无」。
 */
import { getAppStore } from '@/lib/data/app-store';
import {
  PAGE_SIZE,
  SORT_LABEL,
  filterApps,
  paginate,
  parseQuery,
  sortApps,
  toQueryString,
  type AppStats,
  type CatalogItem,
  type CatalogQuery,
  type Category,
  type PlatformOs,
  type Sort,
} from '@/lib/app-store';
import { fillCardStats, renderCard } from './card';

const form = document.querySelector<HTMLElement>('[data-catalog-filter]');
const grid = document.querySelector<HTMLElement>('[data-catalog-grid]');
const statusEl = document.querySelector<HTMLElement>('[data-catalog-status]');
const pager = document.querySelector<HTMLElement>('[data-catalog-pages]');

let catalog: CatalogItem[] | null = null;
let stats: Record<string, AppStats> | null = null;
let statsTried = false;

async function loadCatalog() {
  if (!catalog) {
    const res = await fetch('/apps/catalog.json', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    catalog = (await res.json()) as CatalogItem[];
  }
  return catalog;
}

async function loadStats() {
  if (!statsTried) {
    statsTried = true;
    stats = await getAppStore()
      .stats()
      .catch(() => null);
  }
  return stats;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

if (form && grid && statusEl && pager) {
  const fixedCategory = (form.dataset.fixedCategory || '') as Category | '';
  const fixedPlatform = (form.dataset.fixedPlatform || '') as PlatformOs | '';
  const sel = (name: string) => form.querySelector<HTMLSelectElement>(`select[name=${name}]`)!;
  const sortBtns = [...form.querySelectorAll<HTMLButtonElement>('[data-sort]')];
  const staticGrid = [...grid.children];
  const staticPager = [...pager.children];
  const staticStatus = statusEl.textContent;
  const staticPagerHidden = pager.hidden;

  const state = (): CatalogQuery => ({
    platform: fixedPlatform || (sel('platform').value as PlatformOs | ''),
    category: fixedCategory || (sel('category').value as Category | ''),
    price: sel('price').value as CatalogQuery['price'],
    sort: (sortBtns.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.sort ?? 'new') as Sort,
  });
  const setSort = (s: Sort) =>
    sortBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === s)));

  /** 地址里的查询串只记录用户自己选的（分类页 / 平台页固定的那一项不写） */
  const urlQuery = (q: CatalogQuery, page: number) =>
    toQueryString({
      ...q,
      platform: fixedPlatform ? '' : q.platform,
      category: fixedCategory ? '' : q.category,
      page,
    });

  const isDefault = (q: CatalogQuery) =>
    (!q.platform || q.platform === fixedPlatform) &&
    (!q.category || q.category === fixedCategory) &&
    !q.price &&
    q.sort === 'new';

  function restoreStatic() {
    grid!.replaceChildren(...staticGrid);
    pager!.replaceChildren(...staticPager);
    pager!.hidden = staticPagerHidden;
    statusEl!.textContent = staticStatus;
    if (stats) fillCardStats(grid!, stats);
  }

  async function apply(page = 1, push = true) {
    const q = state();
    if (push) history.replaceState(null, '', location.pathname + urlQuery(q, page));
    if (isDefault(q) && page === 1 && !new URLSearchParams(location.search).has('page')) {
      restoreStatic();
      return;
    }
    grid!.setAttribute('aria-busy', 'true');
    try {
      const items = filterApps(await loadCatalog(), q);
      const needStats = q.sort !== 'new';
      const s = needStats ? await loadStats() : stats;
      const sorted = sortApps(items, q.sort ?? 'new', needStats ? s : null);
      const p = paginate(sorted, page);
      grid!.replaceChildren(...p.items.map((it) => renderCard(it, 'h2')));
      if (s) fillCardStats(grid!, s);
      const fallback = needStats && !s;
      statusEl!.textContent =
        `共 ${p.total} 个应用${p.pages > 1 ? ` · 第 ${p.page} / ${p.pages} 页` : ''} · 按${SORT_LABEL[fallback ? 'new' : (q.sort ?? 'new')]}排序` +
        (fallback ? '（统计数据暂时不可用，已按最新排序）' : '');
      if (!p.items.length) grid!.append(el('p', 'muted', '没有符合条件的应用，换个筛选条件试试。'));
      renderPager(p.page, p.pages);
    } catch {
      statusEl!.textContent = '筛选暂时不可用（目录数据加载失败），可以用上方的分类与平台入口浏览。';
    } finally {
      grid!.removeAttribute('aria-busy');
    }
  }

  function renderPager(page: number, pages: number) {
    pager!.replaceChildren();
    pager!.hidden = pages < 2;
    if (pages < 2) return;
    const btn = (label: string, to: number, current = false, aria?: string) => {
      const b = el(
        'button',
        current ? 'pagination__n' : to === page - 1 || to === page + 1 ? 'btn' : 'pagination__n',
        label,
      );
      b.type = 'button';
      if (current) b.setAttribute('aria-current', 'page');
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', () => {
        void apply(to).then(() => form!.scrollIntoView({ block: 'start' }));
      });
      return b;
    };
    if (page > 1) pager!.append(btn('上一页', page - 1));
    for (let n = 1; n <= pages; n++) pager!.append(btn(String(n), n, n === page, `第 ${n} 页`));
    if (page < pages) pager!.append(btn('下一页', page + 1));
  }

  form.addEventListener('change', () => void apply(1));
  sortBtns.forEach((b) =>
    b.addEventListener('click', () => {
      setSort(b.dataset.sort as Sort);
      void apply(1);
    }),
  );

  // 带查询串打开（分享的筛选链接 / 后退）：恢复状态
  const initial = parseQuery(location.search);
  if (location.search) {
    if (!fixedPlatform && initial.platform) sel('platform').value = initial.platform;
    if (!fixedCategory && initial.category) sel('category').value = initial.category;
    if (initial.price) sel('price').value = initial.price;
    setSort(initial.sort);
    void apply(initial.page, false);
  }

  form.dataset.ready = 'yes';
  // 卡片统计行（只读真实数据；失败就保持空）
  void loadStats().then((s) => {
    if (s) fillCardStats(grid, s);
  });
}

export { PAGE_SIZE };
