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
      // 内容后台（T7.7，Decap CMS）与订阅确认 / 退订页（T7.8）
      'Disallow: /cms/',
      'Disallow: /subscribe/confirm/',
      'Disallow: /subscribe/unsubscribe/',
      'Disallow: /en/subscribe/confirm/',
      'Disallow: /en/subscribe/unsubscribe/',
      'Disallow: /search/?',
      '',
      `Sitemap: ${new URL('sitemap-index.xml', site).href}`,
      `Sitemap: ${new URL('forum/sitemap-threads.xml', site).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
