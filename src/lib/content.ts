import { getCollection, type CollectionEntry } from 'astro:content';
import { compareDesc } from './dates';
import forumData from '../data/forum.json';
import { url } from './routes';
import { toolHue } from './hue';
import type { SearchItem } from './search';
import { excerpt } from './escape';
import {
  AI_CATEGORIES,
  CATEGORIES,
  PLATFORM_LABEL,
  PRICE_LABEL,
  byNewest,
  type CatalogItem,
  type PlatformOs,
  type ToolItem,
} from './app-store';
import { VIDEO_CATEGORIES, channelKey, lengthOf, parseClock, publishedDate, type VideoItem } from './videos';

export type App = CollectionEntry<'apps'>;
export type Tool = CollectionEntry<'tools'>;
export type Video = CollectionEntry<'videos'>;
export type Game = CollectionEntry<'games'>;
export type Article = CollectionEntry<'articles'>;
export type Work = CollectionEntry<'works'>;

const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) =>
  a.data.order - b.data.order;

export const getApps = async () => (await getCollection('apps')).sort(byOrder);
export const getTools = async () => (await getCollection('tools')).sort(byOrder);
export const getVideos = async () => (await getCollection('videos')).sort(byOrder);
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
  const [apps, tools, videos, games, articles, works] = await Promise.all([
    getApps(),
    getTools(),
    getVideos(),
    getGames(),
    getArticles(),
    getWorks(),
  ]);
  return [
    ...apps.map((a) => ({
      type: 'app' as const,
      title: a.data.title,
      url: url.app(a.id),
      // 副标题也参与搜索（「动画编辑器」能搜到 FableMotion）
      summary: `${a.data.subtitle}。${a.data.summary}`,
      pinyin: a.data.pinyin,
      meta: `${CATEGORIES[a.data.category]} · ${a.data.version}`,
    })),
    ...tools.map((t) => ({
      type: 'tool' as const,
      title: t.data.title,
      url: url.tool(t.id),
      summary: t.data.summary,
      pinyin: t.data.pinyin,
      meta: `${t.data.categories.map((c) => AI_CATEGORIES[c]).join(' / ')} · ${t.data.developer.name}`,
    })),
    ...videos.map((v) => ({
      type: 'video' as const,
      title: v.data.title,
      url: url.video(v.id),
      summary: v.data.summary,
      pinyin: v.data.pinyin,
      meta: `${v.data.categories.map((c) => VIDEO_CATEGORIES[c]).join(' / ')} · ${v.data.channel.name} · ${v.data.originalTitle}`,
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

/** 列表卡片用的图标：有多尺寸版本时用 128 px WebP（64 px 显示的 2x），不下载 1024 母版 */
export const cardIcon = (icon: { src: string; variants: boolean }) =>
  icon.variants ? icon.src.replace(/\.(png|svg|webp)$/, '-128.webp') : icon.src;

/** 目录条目（列表卡片 / catalog.json / 客户端筛选共用） */
export function catalogItem(a: App): CatalogItem {
  const d = a.data;
  return {
    slug: a.id,
    title: d.title,
    subtitle: d.subtitle,
    icon: cardIcon(d.icon),
    iconAlt: `${d.title} 图标`,
    iconSrc: d.icon.src,
    iconVariants: d.icon.variants,
    hue: d.hue,
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

// ------------------------------------------------------------- AI 工具 ----

/** /ai/ 卡片条目 */
export function toolItem(t: Tool): ToolItem {
  const d = t.data;
  return {
    slug: t.id,
    title: d.title,
    subtitle: d.subtitle,
    summary: d.summary,
    icon: cardIcon(d.icon),
    iconAlt: `${d.title} 图标`,
    iconSrc: d.icon.src,
    iconVariants: d.icon.variants,
    hue: toolHue(d),
    categories: d.categories,
    platforms: d.platforms.map((p) => p.os),
    price: d.price.model,
    priceLabel: PRICE_LABEL[d.price.model],
    openSource: d.openSource,
    developer: d.developer.name,
    order: d.order,
    url: url.tool(t.id),
  };
}

/** 相关工具：共同分类多的优先，其次共同标签；不含自己，最多 n 个 */
export function relatedTools(tool: Tool, all: Tool[], n = 4): Tool[] {
  const cats = new Set(tool.data.categories);
  const tags = new Set(tool.data.tags);
  return all
    .filter((x) => x.id !== tool.id)
    .map((x) => ({
      x,
      score:
        x.data.categories.filter((c) => cats.has(c)).length * 10 +
        (x.data.categories[0] === tool.data.categories[0] ? 5 : 0) +
        x.data.tags.filter((t) => tags.has(t)).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.x.data.order - b.x.data.order)
    .slice(0, n)
    .map((r) => r.x);
}

// ------------------------------------------------------------ 视频 ----

/** /videos/ 卡片与筛选用的条目 */
export function videoItem(v: Video): VideoItem {
  const d = v.data;
  const seconds = d.duration ? parseClock(d.duration) : null;
  return {
    slug: v.id,
    title: d.title,
    originalTitle: d.originalTitle,
    summary: d.summary,
    provider: d.provider,
    channel: channelKey(d.channel.name),
    channelName: d.channel.name,
    categories: d.categories,
    seconds,
    duration: d.duration ?? '',
    length: lengthOf(seconds),
    published: d.published ? publishedDate(d.published) : '',
    owner: d.owner,
    order: d.order,
    url: url.video(v.id),
  };
}

/** 相关视频：同主分类优先，其次共同分类 / 标签 / 相关工具多的；不含自己，最多 n 个 */
export function relatedVideos(video: Video, all: Video[], n = 3): Video[] {
  const d = video.data;
  const tags = new Set([...d.tags, ...d.relatedTools.map((t) => `tool:${t}`)]);
  return all
    .filter((x) => x.id !== video.id)
    .map((x) => {
      const sameMain = x.data.categories[0] === d.categories[0] ? 4 : 0;
      const cats = x.data.categories.filter((c) => d.categories.includes(c)).length;
      const shared = [...x.data.tags, ...x.data.relatedTools.map((t) => `tool:${t}`)].filter((t) =>
        tags.has(t),
      ).length;
      return { x, score: sameMain + cats + shared * 2 };
    })
    .sort((a, b) => b.score - a.score || a.x.data.order - b.x.data.order)
    .slice(0, n)
    .map((r) => r.x);
}
