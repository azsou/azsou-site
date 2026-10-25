import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getApps } from '@/lib/content';
import { appItem, sortFeed } from '@/lib/feeds';

/** 应用更新 RSS（T7.8）：自研应用与收录应用的版本 / 更新日期 */
export async function GET(context: APIContext) {
  const apps = (await getApps()).filter((a) => !a.id.startsWith('e2e-'));
  return rss({
    title: 'AZ Studio · 应用更新',
    description: '本站应用的版本与更新记录',
    site: context.site!,
    customData: '<language>zh-cn</language>',
    items: sortFeed(apps.map(appItem)),
  });
}
