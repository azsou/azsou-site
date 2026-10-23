import { getCollection, type CollectionEntry } from 'astro:content';
import { compareDesc } from './dates';
import forumData from '../data/forum.json';
import { url } from './routes';
import type { SearchItem } from './search';
import { excerpt } from './escape';

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
      meta: `${a.data.kind} · ${a.data.version}`,
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
