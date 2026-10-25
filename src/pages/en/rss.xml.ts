import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getApps, getGames, getTools, getVideos } from '@/lib/content';
import { enItems } from '@/lib/feeds';

/** 英文 RSS（T7.6 / T7.8）：有英文文案的应用、AI 工具、视频与游戏 */
export async function GET(context: APIContext) {
  const [apps, tools, videos, games] = await Promise.all([getApps(), getTools(), getVideos(), getGames()]);
  return rss({
    title: 'AZ Studio (English)',
    description: 'Apps, AI tools, videos and games from AZ Studio, in English',
    site: context.site!,
    customData: '<language>en</language>',
    items: enItems({ apps, tools, videos, games }),
  });
}
