import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { forum } from '@/lib/content';
import { url } from '@/lib/routes';
import { toDate } from '@/lib/dates';

export function GET(context: APIContext) {
  return rss({
    stylesheet: '/rss.xsl',
    title: 'AZ Studio · 论坛',
    description: '论坛公告与站点预置主题',
    site: context.site!,
    customData: '<language>zh-cn</language>',
    items: [...forum.seeds]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((t) => ({
        title: t.title,
        link: url.forumThread(t.id),
        pubDate: toDate(t.date),
        description: t.body.slice(0, 200),
        author: t.author,
      })),
  });
}
