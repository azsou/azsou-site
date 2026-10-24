/** 目录卡片的浏览器端渲染（与 AppCard.astro 同一结构），以及卡片上的评分 / 下载数一行。 */
import { PLATFORM_LABEL, formatCount, formatRating, type AppStats, type CatalogItem } from '@/lib/app-store';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderCard(item: CatalogItem, headingLevel: 'h2' | 'h3' = 'h3'): HTMLElement {
  const card = el('article', 'card card--row app-card');
  card.dataset.app = item.slug;
  const img = el('img', 'app-icon-img app-icon-img--md');
  img.src = item.icon;
  img.alt = item.iconAlt;
  img.width = 64;
  img.height = 64;
  img.loading = 'lazy';
  img.decoding = 'async';
  const body = el('div', 'card__body');
  const h = el(headingLevel, 'card__title');
  const a = el('a', 'card__link', item.title);
  a.href = item.url;
  h.append(a);
  const meta = el('div', 'card__meta');
  const dot = () => {
    const s = el('span', undefined, '·');
    s.setAttribute('aria-hidden', 'true');
    return s;
  };
  meta.append(
    el('span', undefined, item.categoryLabel),
    dot(),
    el('span', undefined, item.priceLabel),
    el('span', `badge status status--${item.statusClass}`, item.status),
  );
  body.append(
    h,
    el('p', 'card__text', item.subtitle),
    meta,
    el('p', 'app-card__platforms', item.platforms.map((p) => PLATFORM_LABEL[p]).join(' · ')),
  );
  const stats = el('p', 'app-card__stats');
  stats.dataset.cardStats = '';
  body.append(stats);
  card.append(img, body);
  return card;
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
  for (const card of root.querySelectorAll<HTMLElement>('.app-card[data-app]')) {
    const line = card.querySelector<HTMLElement>('[data-card-stats]');
    if (line) line.textContent = statsText(stats[card.dataset.app!]);
  }
}
