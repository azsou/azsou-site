/**
 * 应用目录 island：筛选（平台 / 分类 / 价格）、排序（最新 / 热门 / 评分）、结果分页，状态写进 URL 查询串（可分享、可后退）。
 * 静态页是「最新」排序的第 N 页；只有用户改了筛选 / 排序（或打开带查询串的地址）时才接管列表。
 * 卡片上的评分 / 下载数一行：读真实统计（app_download_counts / app_review_stats），读不到就保持「暂无」。
 */
import { getAppStore } from '@/lib/data/app-store';
import { initMoreFilters, setMoreFiltersCount } from '@/scripts/more-filters';
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
  /** 分类只由胶囊（分类页）决定；分享链接里的 ?category= 仍然恢复（T9.12 去掉了重复的分类下拉） */
  let urlCategory = '' as Category | '';
  const moreRoot = form.closest<HTMLElement>('[data-more-filters]');
  const sortBtns = [...form.querySelectorAll<HTMLButtonElement>('[data-sort]')];
  const staticGrid = [...grid.children];
  const staticPager = [...pager.children];
  const staticStatus = statusEl.textContent;
  const staticPagerHidden = pager.hidden;

  const state = (): CatalogQuery => ({
    platform: fixedPlatform || (sel('platform').value as PlatformOs | ''),
    category: fixedCategory || urlCategory,
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
    if (moreRoot)
      setMoreFiltersCount(
        moreRoot,
        Number(!fixedPlatform && !!q.platform) + Number(!!q.price) + Number((q.sort ?? 'new') !== 'new'),
      );
    // F02：地址是唯一的状态来源。只写规范化后的查询串（未知参数、无效取值丢弃）；越界页码在下面按实际页数纠正
    // 应用目录页同时有 ListShell 的客户端排序（最新 / 名称 / 编辑推荐，同样写 ?sort=）：那一组的取值原样保留，不当未知参数丢弃
    const shellSort = new URLSearchParams(location.search).get('sort');
    const keepShell =
      q.sort === 'new' &&
      !!shellSort &&
      !!document.querySelector(`[data-entry-sort="${CSS.escape(shellSort)}"]`);
    const canon = (p: number) => {
      const qs = new URLSearchParams(urlQuery(q, p));
      if (keepShell) qs.set('sort', shellSort!);
      const str = qs.toString();
      return location.pathname + (str ? `?${str}` : '') + location.hash;
    };
    const setUrl = (p: number) => {
      if (location.pathname + location.search + location.hash !== canon(p))
        history.replaceState(null, '', canon(p));
    };
    const wantedPage = new URLSearchParams(location.search).has('page') || page > 1;
    if (push || location.search) setUrl(page);
    if (isDefault(q) && page === 1 && !wantedPage) {
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
      // 页码超出（分享的旧链接 / 筛选后结果变少）：纠正到最后一页并写回地址
      if (p.page !== page) setUrl(p.page);
      grid!.replaceChildren(...p.items.map((it) => renderCard(it, 'h2')));
      if (s) fillCardStats(grid!, s);
      const fallback = needStats && !s;
      statusEl!.textContent =
        `共 ${p.total} 个应用${p.pages > 1 ? ` · 第 ${p.page} / ${p.pages} 页` : ''} · 按${SORT_LABEL[fallback ? 'new' : (q.sort ?? 'new')]}排序` +
        (fallback ? '（统计数据暂时不可用，已按最新排序）' : '');
      if (!p.items.length) {
        const empty = el('li', 'muted', '没有符合条件的应用，换个筛选条件试试。');
        grid!.append(empty);
      }
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
    if (!fixedCategory && initial.category) urlCategory = initial.category;
    if (initial.price) sel('price').value = initial.price;
    setSort(initial.sort);
    void apply(initial.page, false);
  }

  initMoreFilters();
  form.dataset.ready = 'yes';
  // 卡片统计行（只读真实数据；失败就保持空）
  void loadStats().then((s) => {
    if (s) fillCardStats(grid, s);
  });
}

export { PAGE_SIZE };
