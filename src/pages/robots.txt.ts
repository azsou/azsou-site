import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin/',
      'Disallow: /settings/',
      'Disallow: /notifications/',
      'Disallow: /bookmarks/',
      'Disallow: /forum/new/',
      // 下载中转页：不让爬虫进入（也不会被计数）
      'Disallow: /go/',
      'Disallow: /search/?',
      '',
      `Sitemap: ${new URL('sitemap-index.xml', site).href}`,
      `Sitemap: ${new URL('forum/sitemap-threads.xml', site).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
