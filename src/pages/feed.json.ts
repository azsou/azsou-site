import type { APIContext } from 'astro';
import { getApps, getArticles, getGames, getVideos, getWorks } from '@/lib/content';
import { appItem, articleItem, gameItem, jsonFeed, sortFeed, videoItemFeed, workItem } from '@/lib/feeds';
import { SITE } from '@/lib/site';

/** 全站 JSON Feed 1.1（T7.8）：文章 + 应用 + 视频 + 游戏 + 作品 */
export async function GET(context: APIContext) {
  const [articles, apps, videos, games, works] = await Promise.all([
    getArticles(),
    getApps(),
    getVideos(),
    getGames(),
    getWorks(),
  ]);
  const body = jsonFeed({
    site: String(context.site),
    title: 'AZ Studio · 全站更新',
    description: '真实项目、版本记录与可复现结论',
    homePath: '/',
    feedPath: '/feed.json',
    language: 'zh-CN',
    author: SITE.author,
    items: sortFeed([
      ...articles.map(articleItem),
      ...apps.filter((a) => !a.id.startsWith('e2e-')).map(appItem),
      ...videos.map(videoItemFeed),
      ...games.map(gameItem),
      ...works.map(workItem),
    ]),
  });
  return new Response(body, { headers: { 'content-type': 'application/feed+json; charset=utf-8' } });
}
