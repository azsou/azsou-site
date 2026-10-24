// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';

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
  '/forum/thread/',
  '/404/',
  '/auth/',
  '/api/',
];

export default defineConfig({
  site: SITE,
  // 静态输出；adapter 已就位，后续 P2/P3 的论坛/用户页可用 `export const prerender = false` 按需渲染
  output: 'static',
  adapter: vercel({ webAnalytics: { enabled: false } }),
  trailingSlash: 'always',
  // 整站 CSS 内联（gzip 后约 6KB）：省掉一次阻塞渲染的往返，移动端 LCP 预算 < 2.0s 的关键
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  integrations: [
    sitemap({
      filter: (page) => !NOINDEX.some((p) => new URL(page).pathname.startsWith(p)),
      changefreq: 'weekly',
    }),
  ],
  vite: { build: { assetsInlineLimit: 2048 } },
});
