import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getArticles } from '@/lib/content';
import { url } from '@/lib/routes';
import { toDate } from '@/lib/dates';
import { excerpt } from '@/lib/escape';

export async function GET(context: APIContext) {
  const articles = await getArticles();
  return rss({
    stylesheet: '/rss.xsl',
    title: 'AZ Studio · 原创技术文章',
    description: '真实项目、版本记录与可复现结论',
    site: context.site!,
    customData: '<language>zh-cn</language>',
    items: articles.map((a) => ({
      title: a.data.title,
      link: url.article(a.id),
      pubDate: toDate(a.data.date),
      description: excerpt(a.body ?? '', 300),
      categories: [a.data.category, a.data.badge],
      author: a.data.author,
    })),
  });
}
