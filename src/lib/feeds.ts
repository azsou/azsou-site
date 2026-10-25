/**
 * 订阅源（T7.8）：RSS（全站 / 文章 / 应用 / 视频 / 论坛 / 英文）+ JSON Feed 1.1（/feed.json、/en/feed.json）。
 * 条目只来自内容集合的真实数据；日期只用档案里记录的日期（应用：updated → releaseDate → 最新更新日志；
 * 视频：频道 RSS 核实的发布时间），没有日期的条目照样收录但不写日期，不编造。
 */
import { toDate } from './dates';
import { excerpt } from './escape';
import { url } from './routes';
import type { App, Article, Game, Tool, Video, Work } from './content';
import { CATEGORIES } from './app-store';
import { VIDEO_CATEGORIES } from './videos';
import { EN_AI_CATEGORY, EN_CATEGORY, EN_VIDEO_CATEGORY } from './i18n-labels';

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: Date;
  categories: string[];
  author?: string;
}

export const appDate = (a: App): Date | undefined => {
  const d = a.data.updated ?? a.data.releaseDate ?? a.data.changelog[0]?.date;
  return d ? toDate(d) : undefined;
};

export const articleItem = (a: Article): FeedItem => ({
  title: a.data.title,
  link: url.article(a.id),
  pubDate: toDate(a.data.date),
  description: excerpt(a.body ?? '', 300),
  categories: [a.data.category, a.data.badge],
  author: a.data.author,
});

export const appItem = (a: App): FeedItem => ({
  title: `${a.data.title} ${a.data.version}`,
  link: url.app(a.id),
  pubDate: appDate(a),
  description: `${a.data.subtitle}。${a.data.summary}`,
  categories: [CATEGORIES[a.data.category], '应用'],
});

export const videoItemFeed = (v: Video): FeedItem => ({
  title: v.data.title,
  link: url.video(v.id),
  pubDate: v.data.published ? new Date(v.data.published) : undefined,
  description: `${v.data.summary}（${v.data.channel.name} 官方视频：${v.data.originalTitle}）`,
  categories: [...v.data.categories.map((c) => VIDEO_CATEGORIES[c]), '视频'],
});

export const gameItem = (g: Game): FeedItem => ({
  title: `${g.data.title} ${g.data.version}`,
  link: url.game(g.id),
  pubDate: toDate(g.data.date),
  description: excerpt(g.body ?? '', 200),
  categories: ['游戏'],
});

export const workItem = (w: Work): FeedItem => ({
  title: w.data.title,
  link: url.work(w.id),
  pubDate: toDate(w.data.date),
  description: excerpt(w.body ?? '', 200),
  categories: ['作品'],
});

/** 英文订阅源：只收有英文文案的条目，链接到 /en/ 页面 */
export function enItems(c: { apps: App[]; tools: Tool[]; videos: Video[]; games: Game[] }): FeedItem[] {
  return sortFeed([
    ...c.apps
      .filter((a) => a.data.en)
      .map((a) => ({
        title: `${a.data.en!.title ?? a.data.title} ${a.data.version}`,
        link: `/en/apps/${a.id}/`,
        pubDate: appDate(a),
        description: a.data.en!.summary,
        categories: [EN_CATEGORY[a.data.category], 'App'],
      })),
    ...c.tools
      .filter((t) => t.data.en)
      .map((t) => ({
        title: t.data.en!.title ?? t.data.title,
        link: `/en/ai/${t.id}/`,
        pubDate: toDate(t.data.lastChecked),
        description: t.data.en!.summary,
        categories: [...t.data.categories.map((c) => EN_AI_CATEGORY[c]), 'AI tool'],
      })),
    ...c.videos
      .filter((v) => v.data.en)
      .map((v) => ({
        title: v.data.originalTitle,
        link: `/en/videos/${v.id}/`,
        pubDate: v.data.published ? new Date(v.data.published) : undefined,
        description: v.data.en!.summary,
        categories: [...v.data.categories.map((c) => EN_VIDEO_CATEGORY[c]), 'Video'],
      })),
    ...c.games
      .filter((g) => g.data.en)
      .map((g) => ({
        title: `${g.data.en!.title ?? g.data.title} ${g.data.version}`,
        link: `/en/games/${g.id}/`,
        pubDate: toDate(g.data.date),
        description: g.data.en!.summary,
        categories: ['Game'],
      })),
  ]);
}

/** 新的在前；没有日期的排最后（保持原顺序） */
export function sortFeed(items: FeedItem[]): FeedItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) => (b.it.pubDate?.getTime() ?? -Infinity) - (a.it.pubDate?.getTime() ?? -Infinity) || a.i - b.i,
    )
    .map((x) => x.it);
}

/** JSON Feed 1.1（https://www.jsonfeed.org/version/1.1/） */
export function jsonFeed(o: {
  site: string;
  title: string;
  description: string;
  homePath: string;
  feedPath: string;
  language: string;
  items: FeedItem[];
  author: { name: string; url: string };
}): string {
  const abs = (p: string) => new URL(p, o.site).toString();
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: o.title,
    home_page_url: abs(o.homePath),
    feed_url: abs(o.feedPath),
    description: o.description,
    language: o.language,
    icon: abs('/icons/icon-512.png'),
    favicon: abs('/favicon.svg'),
    authors: [o.author],
    items: o.items.map((it) => ({
      id: abs(it.link),
      url: abs(it.link),
      title: it.title,
      content_text: it.description,
      summary: it.description,
      ...(it.pubDate ? { date_published: it.pubDate.toISOString() } : {}),
      tags: it.categories,
      ...(it.author ? { authors: [{ name: it.author }] } : {}),
    })),
  });
}
