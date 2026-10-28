import type { APIRoute } from 'astro';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { fetchThreadRefs, threadSitemapXml } from '@/lib/server/forum-sitemap';

/** 按需渲染（Vercel Function），CDN 缓存 1 小时、过期后后台刷新 */
export const prerender = false;

export const GET: APIRoute = async ({ site }) => {
  let cfg;
  try {
    cfg = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  try {
    const rows = await fetchThreadRefs(cfg);
    return new Response(threadSitemapXml(String(site ?? 'https://azsou.com'), rows), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return new Response('upstream unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' },
    });
  }
};
