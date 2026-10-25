/**
 * 设计门禁的页面清单与视口（DESIGN-QA §2.2 / §2.12）。
 * 只放静态可渲染的公开页面；需要数据库的社区页 / 后台页由 e2e 覆盖，视觉基线待 T9.16 后台外壳完成再加。
 */
export type DesignPage = { name: string; path: string; core?: boolean };

export const PAGES: DesignPage[] = [
  { name: 'home', path: '/', core: true },
  { name: 'apps', path: '/apps/', core: true },
  { name: 'apps-category', path: '/apps/category/browser-tools/' },
  { name: 'app-detail', path: '/apps/fablemotion/', core: true },
  { name: 'ai', path: '/ai/', core: true },
  { name: 'ai-category', path: '/ai/category/agent/' },
  { name: 'ai-detail', path: '/ai/claude-code/', core: true },
  { name: 'videos', path: '/videos/' },
  { name: 'video-detail', path: '/videos/claude-code-best-practices/' },
  { name: 'games', path: '/games/' },
  { name: 'game-detail', path: '/games/emberdeep/' },
  { name: 'articles', path: '/articles/' },
  { name: 'article-detail', path: '/articles/pinyin-initial-search/', core: true },
  { name: 'works', path: '/works/' },
  { name: 'tags', path: '/tags/' },
  { name: 'tag-detail', path: '/tags/mcp/' },
  { name: 'subscribe', path: '/subscribe/' },
  { name: 'privacy', path: '/privacy/' },
  { name: 'about', path: '/about/' },
  { name: '404', path: '/404.html' },
  { name: 'en-home', path: '/en/' },
  { name: 'en-apps', path: '/en/apps/' },
  { name: 'en-ai-detail', path: '/en/ai/claude-code/' },
  { name: 'kit', path: '/_kit/' },
  { name: 'kit-prose', path: '/_kit/prose/' },
];

/** Q12 视口全集：320–2560 + 两个横屏 */
export const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
  { name: '1920', width: 1920, height: 1080 },
  { name: '2560', width: 2560, height: 1440 },
  { name: '844x390', width: 844, height: 390 },
  { name: '740x360', width: 740, height: 360 },
] as const;

export const FIXED_TIME = '2026-10-25T12:00:00+08:00';
