// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';

export const SITE = 'https://azsou.com';

/** 不进 sitemap 的页面：账户/后台占位、搜索结果、离线页、论坛动态主题页 */
const NOINDEX = [
  '/login/',
  '/register/',
  '/reset-password/',
  '/settings/',
  '/notifications/',
  '/admin/',
  '/u/',
  '/search/',
  '/offline/',
  '/_kit/',
  '/forum/new/',
  '/bookmarks/',
  '/404/',
  '/auth/',
  '/api/',
  '/go/',
  '/subscribe/confirm/',
  '/subscribe/unsubscribe/',
  '/en/subscribe/confirm/',
  '/en/subscribe/unsubscribe/',
  '/cms/',
];

/**
 * 只有 1 个条目的标签页 noindex（src/pages/tags/[tag].astro，TAG_INDEX_MIN = 2），也不进 sitemap。
 * sitemap 过滤在配置里运行、拿不到内容集合，这里直接读内容文件的 JSON frontmatter 计数（与 getTaggedItems 同样的四类）。
 */
function thinTags() {
  const counts = new Map();
  for (const dir of ['apps', 'tools', 'videos', 'articles']) {
    const root = path.join('src/content', dir);
    if (!fs.existsSync(root)) continue;
    const files = fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.md'));
    for (const f of files) {
      if (String(f).startsWith('_e2e') && !process.env.AZ_E2E_FIXTURES) continue;
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(root, String(f)), 'utf8'));
      let tags;
      try {
        tags = JSON.parse(m?.[1] ?? '{}').tags ?? [];
      } catch {
        tags = [];
      }
      for (const t of new Set(tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, n]) => n < 2).map(([t]) => `/tags/${t}/`));
}
const THIN_TAGS = thinTags();

export default defineConfig({
  site: SITE,
  // 静态输出；adapter 已就位，后续 P2/P3 的论坛/用户页可用 `export const prerender = false` 按需渲染
  output: 'static',
  adapter: vercel({ webAnalytics: { enabled: false } }),
  trailingSlash: 'always',
  // 中英双语（T7.6）：中文默认、在根路径；英文在 /en/ 下（只有写了英文文案的页面才有英文版，见 src/lib/i18n.ts）
  i18n: { defaultLocale: 'zh', locales: ['zh', 'en'], routing: { prefixDefaultLocale: false } },
  // 整站 CSS 内联（gzip 后约 6KB）：省掉一次阻塞渲染的往返，移动端 LCP 预算 < 2.0s 的关键
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  integrations: [
    sitemap({
      // 中英对应页面互相写 xhtml:link 备用语言（页面 <head> 里另有 hreflang + x-default）
      i18n: { defaultLocale: 'zh', locales: { zh: 'zh-CN', en: 'en' } },
      filter: (page) => {
        const path = new URL(page).pathname;
        // /forum/t/ 是数据库主题的外壳（?id=…，由 /forum/sitemap-threads.xml 列出）；/forum/t/t-xxx/ 种子主题照常收录
        return path !== '/forum/t/' && !THIN_TAGS.has(path) && !NOINDEX.some((p) => path.startsWith(p));
      },
      changefreq: 'weekly',
    }),
  ],
  vite: { build: { assetsInlineLimit: 2048 } },
});
