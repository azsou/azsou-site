import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getArticles, getGames, getWorks } from '@/lib/content';
import { url } from '@/lib/routes';
import { toDate } from '@/lib/dates';
import { excerpt } from '@/lib/escape';

/** 全站 RSS：文章 + 游戏版本 + 作品 */
export async function GET(context: APIContext) {
  const [articles, games, works] = await Promise.all([getArticles(), getGames(), getWorks()]);
  const items = [
    ...articles.map((a) => ({
      title: a.data.title,
      link: url.article(a.id),
      pubDate: toDate(a.data.date),
      description: excerpt(a.body ?? '', 200),
      categories: [a.data.category],
    })),
    ...games.map((g) => ({
      title: `${g.data.title} ${g.data.version}`,
      link: url.game(g.id),
      pubDate: toDate(g.data.date),
      description: excerpt(g.body ?? '', 200),
      categories: ['游戏'],
    })),
    ...works.map((w) => ({
      title: w.data.title,
      link: url.work(w.id),
      pubDate: toDate(w.data.date),
      description: excerpt(w.body ?? '', 200),
      categories: ['作品'],
    })),
  ].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  return rss({
    stylesheet: '/rss.xsl',
    title: 'AZ Studio · 全站更新',
    description: '真实项目、版本记录与可复现结论',
    site: context.site!,
    customData: '<language>zh-cn</language>',
    items,
  });
}
