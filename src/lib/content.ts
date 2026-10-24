import { getCollection, type CollectionEntry } from 'astro:content';
import { compareDesc } from './dates';
import forumData from '../data/forum.json';
import { url } from './routes';
import type { SearchItem } from './search';
import { excerpt } from './escape';
import {
  CATEGORIES,
  PLATFORM_LABEL,
  PRICE_LABEL,
  byNewest,
  type CatalogItem,
  type PlatformOs,
} from './app-store';

export type App = CollectionEntry<'apps'>;
export type Game = CollectionEntry<'games'>;
export type Article = CollectionEntry<'articles'>;
export type Work = CollectionEntry<'works'>;

const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) =>
  a.data.order - b.data.order;

export const getApps = async () => (await getCollection('apps')).sort(byOrder);
export const getGames = async () => (await getCollection('games')).sort(byOrder);
export const getWorks = async () => (await getCollection('works')).sort(byOrder);
/** 文章按发布日期倒序；同日按原顺序 */
export const getArticles = async () =>
  (await getCollection('articles')).sort(
    (a, b) => compareDesc(a.data.date, b.data.date) || a.data.order - b.data.order,
  );

export const forum = forumData;
export type ForumSeed = (typeof forumData.seeds)[number];
export type ForumCategory = (typeof forumData.categories)[number];

export async function buildSearchIndex(): Promise<SearchItem[]> {
  const [apps, games, articles, works] = await Promise.all([
    getApps(),
    getGames(),
    getArticles(),
    getWorks(),
  ]);
  return [
    ...apps.map((a) => ({
      type: 'app' as const,
      title: a.data.title,
      url: url.app(a.id),
      summary: a.data.summary,
      pinyin: a.data.pinyin,
      meta: `${CATEGORIES[a.data.category]} · ${a.data.version}`,
    })),
    ...games.map((g) => ({
      type: 'game' as const,
      title: g.data.title,
      url: url.game(g.id),
      summary: excerpt(g.body ?? '', 80),
      pinyin: g.data.pinyin,
      meta: `${g.data.genre} · ${g.data.version}`,
    })),
    ...articles.map((a) => ({
      type: 'article' as const,
      title: a.data.title,
      url: url.article(a.id),
      summary: excerpt(a.body ?? '', 80),
      pinyin: a.data.pinyin,
      meta: `${a.data.category} · ${a.data.date}`,
    })),
    ...works.map((w) => ({
      type: 'work' as const,
      title: w.data.title,
      url: url.work(w.id),
      summary: excerpt(w.body ?? '', 80),
      pinyin: w.data.pinyin,
      meta: `${w.data.kind} · ${w.data.date}`,
    })),
    ...forum.seeds.map((t) => ({
      type: 'thread' as const,
      title: t.title,
      url: url.forumThread(t.id),
      summary: excerpt(t.body, 80),
      pinyin: t.pinyin,
      meta: `论坛 · ${t.date}`,
    })),
  ];
}

// ------------------------------------------------------------ 应用商店 ----

/** 目录条目（列表卡片 / catalog.json / 客户端筛选共用） */
export function catalogItem(a: App): CatalogItem {
  const d = a.data;
  return {
    slug: a.id,
    title: d.title,
    subtitle: d.subtitle,
    icon: d.icon.src,
    iconAlt: `${d.title} 图标`,
    category: d.category,
    categoryLabel: CATEGORIES[d.category],
    tags: d.tags,
    platforms: d.platforms.map((p) => p.os),
    price: d.price.model,
    priceLabel: d.price.model === 'paid' && d.price.amount ? d.price.amount : PRICE_LABEL[d.price.model],
    version: d.version,
    status: d.status,
    statusClass: d.statusClass,
    featured: d.featured,
    updated: d.updated ?? '',
    order: d.order,
    url: url.app(a.id),
  };
}

/** 目录默认顺序（最新）：更新日期新的在前，同日按 order */
export const getCatalog = async () => (await getApps()).map(catalogItem).sort(byNewest);

/** 相关应用：同分类优先，其次共同标签多的；不含自己，最多 n 个 */
export function relatedApps(app: App, all: App[], n = 4): App[] {
  const tags = new Set(app.data.tags);
  return all
    .filter((x) => x.id !== app.id)
    .map((x) => ({
      x,
      score: (x.data.category === app.data.category ? 10 : 0) + x.data.tags.filter((t) => tags.has(t)).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.x.data.order - b.x.data.order)
    .slice(0, n)
    .map((r) => r.x);
}

/** 平台列表文字（「网页版 / Windows」） */
export const platformText = (oses: PlatformOs[]) => oses.map((o) => PLATFORM_LABEL[o]).join(' / ');
