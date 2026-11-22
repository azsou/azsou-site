import type { APIRoute, GetStaticPaths } from 'astro';
import { adsTxt } from '@/lib/ads';

/**
 * /ads.txt（P8 T8.3）：只有设置了 PUBLIC_ADSENSE_CLIENT 才生成（getStaticPaths 返回空 = 没有这个文件，访问 404）。
 * 内容：google.com, pub-…, DIRECT, f08c47fec0942fa0
 */
export const getStaticPaths: GetStaticPaths = () =>
  adsTxt(import.meta.env) ? [{ params: { file: 'ads' } }] : [];

export const GET: APIRoute = () =>
  new Response(adsTxt(import.meta.env) ?? '', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
