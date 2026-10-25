import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getVideos } from '@/lib/content';
import { sortFeed, videoItemFeed } from '@/lib/feeds';

/** 视频 RSS（T7.8）：收录的官方视频与本站原创导读；发布时间只写频道 RSS 核实过的 */
export async function GET(context: APIContext) {
  return rss({
    stylesheet: '/rss.xsl',
    title: 'AZ Studio · 视频',
    description: 'AI 编程与游戏开发的官方视频，附本站原创中文导读',
    site: context.site!,
    customData: '<language>zh-cn</language>',
    items: sortFeed((await getVideos()).map(videoItemFeed)),
  });
}
