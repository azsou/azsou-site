/** 目录条目的浏览器端渲染，以及（详情页等仍在用的）评分 / 下载数文字。 */
import { iconFallbackSrc, iconSrcset } from '@/lib/icons';
import { formatCount, formatRating, type AppStats, type CatalogItem } from '@/lib/app-store';
import { formatDate } from '@/lib/dates';
import { versionText } from '@/lib/store';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * 目录条目的浏览器端渲染（P10：与 StoreEntry.astro 的 tile 形态同一结构，<li> 包 <article class="entry">）。
 * 不显示评分（站长决定）；元数据只放有值的项。
 */
export function renderCard(item: CatalogItem, headingLevel: 'h2' | 'h3' = 'h3'): HTMLElement {
  const li = el('li');
  const card = el('article', 'entry entry--tile');
  card.dataset.entry = item.slug;
  card.dataset.app = item.slug;
  card.dataset.type = 'app';
  card.dataset.sortNew = item.updated;
  card.dataset.sortName = (item.pinyin || item.title).toLowerCase();
  card.dataset.sortEditor = String(item.order);
  const img = el('img', 'app-icon-img app-icon-img--lg');
  img.src = item.iconVariants ? iconFallbackSrc(item.iconSrc, 'lg') : item.icon;
  img.alt = ''; // 名称就在旁边（DESIGN-SYSTEM §19.3）
  img.width = 72;
  img.height = 72;
  img.loading = 'lazy';
  img.decoding = 'async';
  // 与 AppIcon.astro（variants）同一结构：<picture> + AVIF source，WebP 1x / 2x 兜底
  let icon: HTMLElement = img;
  if (item.iconVariants) {
    img.srcset = iconSrcset(item.iconSrc, 'lg', 'webp');
    const pic = el('picture', 'app-icon-pic');
    const source = el('source');
    source.type = 'image/avif';
    source.srcset = iconSrcset(item.iconSrc, 'lg', 'avif');
    pic.append(source, img);
    icon = pic;
  }
  const iconWrap = el('span', 'entry__icon');
  iconWrap.append(icon);
  const body = el('div', 'entry__body');
  const h = el(headingLevel, 'entry__title');
  const a = el('a', 'entry__link', item.title);
  a.href = item.url;
  h.append(a);
  const meta = el('p', 'entry__meta');
  meta.append(el('span', 'entry__type entry__type--app', '应用'));
  const facts = [
    item.categoryLabel,
    item.version && versionText(item.version),
    item.updated && formatDate(item.updated),
  ].filter(Boolean) as string[];
  if (facts.length) {
    // 与 StoreEntry.astro 相同：每条事实不折行，分隔点留在行尾
    const wrap = el('span', 'entry__facts');
    facts.forEach((f, i) => {
      wrap.append(el('span', 'entry__fact', i < facts.length - 1 ? `${f} ·` : f));
      if (i < facts.length - 1) wrap.append(' ');
    });
    meta.append(wrap);
  }
  body.append(h, el('p', 'entry__by', item.developer ?? item.subtitle), meta);
  card.append(iconWrap, body);
  const act = item.action ?? { label: '了解', href: item.url, outbound: false };
  const btn = el('a', 'entry__action', act.label);
  btn.href = act.href;
  btn.setAttribute('aria-label', `${act.label}：${item.title}`);
  if (act.outbound) btn.dataset.outbound = '';
  card.append(btn);
  li.append(card);
  return li;
}

/** 卡片统计行：「★ 4.5（3 条评价）· 下载 12 次」；没有数据就写「暂无评分」，不编造 */
export function statsText(s: AppStats | undefined): string {
  const parts: string[] = [];
  parts.push(
    s && s.average !== null && s.reviews > 0
      ? `★ ${formatRating(s.average)}（${s.reviews} 条评价）`
      : '暂无评分',
  );
  if (s && s.downloads > 0) parts.push(`下载 ${formatCount(s.downloads)} 次`);
  return parts.join(' · ');
}

export function fillCardStats(root: ParentNode, stats: Record<string, AppStats>) {
  for (const card of root.querySelectorAll<HTMLElement>('[data-app]')) {
    const line = card.querySelector<HTMLElement>('[data-card-stats]');
    if (line) line.textContent = statsText(stats[card.dataset.app!]);
  }
}
