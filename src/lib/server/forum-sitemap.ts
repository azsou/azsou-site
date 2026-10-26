/**
 * 论坛数据库主题的 sitemap（/forum/sitemap-threads.xml，Vercel Function + CDN 缓存）。
 * 静态 sitemap-index 覆盖全部 SSG 页面；用户主题只存在于数据库，由这里列出 /forum/t/?id=… 供搜索引擎发现。
 * 只读 forum_threads 的 V72 原有列（id / created_at / published），生产库迁移前后都能用。
 */
export interface ThreadRef {
  id: string;
  created_at: string;
  edited_at?: string | null;
}

const xmlEscape = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

export function threadSitemapXml(site: string, rows: ThreadRef[]): string {
  const base = site.replace(/\/$/, '');
  const urls = rows
    .filter((r) => /^[0-9a-f-]{36}$/i.test(r.id))
    .map((r) => {
      const mod = new Date(r.edited_at || r.created_at);
      const lastmod = Number.isNaN(mod.getTime()) ? '' : `<lastmod>${mod.toISOString()}</lastmod>`;
      return `<url><loc>${xmlEscape(`${base}/forum/t/?id=${r.id}`)}</loc>${lastmod}<changefreq>daily</changefreq></url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>\n`;
}

export async function fetchThreadRefs(
  cfg: { url: string; key: string },
  f: typeof fetch = fetch,
): Promise<ThreadRef[]> {
  const res = await f(
    `${cfg.url}/rest/v1/forum_threads?select=id,created_at&published=eq.true&order=created_at.desc&limit=5000`,
    { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ThreadRef[];
}
