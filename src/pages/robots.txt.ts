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
      'Disallow: /search/?',
      '',
      `Sitemap: ${new URL('sitemap-index.xml', site).href}`,
      `Sitemap: ${new URL('forum/sitemap-threads.xml', site).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
