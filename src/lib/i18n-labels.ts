/**
 * 英文版界面文案（T7.6）。中文文案仍在各自模块里（site.ts / app-store.ts / videos.ts），这里是一一对应的英文。
 * tests/unit/i18n.test.ts 检查每个中文键都有英文。
 */
import type { AiCategory, Category, LinkType, PlatformOs, PriceModel } from './app-store';
import type { VideoCategory } from './videos';

export const EN_SITE = {
  title: 'AZ Studio · Indie apps, AI tools and dev notes',
  description:
    'A personal developer site: indie apps, curated AI tools, videos, games and original articles. Real projects with version history and last-checked dates.',
} as const;

export const EN_NAV = [
  { href: '/en/', label: 'Home', tab: 'Home', icon: 'home' },
  { href: '/en/apps/', label: 'Apps', tab: 'Apps', icon: 'apps' },
  { href: '/en/ai/', label: 'AI Tools' },
  { href: '/en/videos/', label: 'Videos' },
  { href: '/en/games/', label: 'Games', tab: 'Games', icon: 'games' },
  { href: '/en/articles/', label: 'Articles', tab: 'Articles', icon: 'articles' },
];

export const EN_FOOTER = [
  {
    title: 'Explore',
    links: [
      { href: '/en/apps/', label: 'Apps' },
      { href: '/en/ai/', label: 'AI Tools' },
      { href: '/en/videos/', label: 'Videos' },
      { href: '/en/games/', label: 'Games & demos' },
      { href: '/en/articles/', label: 'Articles (Chinese)' },
    ],
  },
  {
    title: 'Follow',
    links: [
      { href: '/en/subscribe/', label: 'Email updates' },
      { href: '/rss.xml', label: 'RSS (Chinese)' },
      { href: '/en/rss.xml', label: 'RSS (English)' },
      { href: '/feed.json', label: 'JSON Feed (Chinese)' },
    ],
  },
  {
    title: 'Site',
    links: [
      { href: '/en/about/', label: 'About' },
      { href: '/en/contact/', label: 'Contact' },
      { href: '/en/privacy/', label: 'Privacy policy' },
      { href: '/en/cookies/', label: 'Cookie policy' },
      { href: '/en/cookies/#choices', label: 'Cookie settings' },
      { href: '/en/ad-disclosure/', label: 'Ad & affiliate disclosure' },
    ],
  },
];

export const EN_PLATFORM: Record<PlatformOs, string> = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: 'Web',
  cli: 'CLI',
  'browser-ext': 'Browser extension',
  'ai-bot': 'AI Bot',
  mcp: 'MCP',
};

export const EN_LINK_TYPE: Record<LinkType, string> = {
  direct: 'Direct download',
  official: 'Official site',
  store: 'App store',
  github: 'GitHub Release',
  web: 'Use online',
};

export const EN_CATEGORY: Record<Category, string> = {
  creative: 'Creative tools',
  'browser-tools': 'Browser tools',
  utilities: 'Utilities',
  ai: 'AI tools',
  'dev-tools': 'Developer tools',
  games: 'Games',
};

export const EN_AI_CATEGORY: Record<AiCategory, string> = {
  agent: 'AI Agent',
  'vibe-coding': 'Vibe Coding',
  cli: 'CLI tools',
  'ai-bot': 'AI Bot',
  mcp: 'MCP',
};

export const EN_PRICE: Record<PriceModel, string> = {
  free: 'Free',
  freemium: 'Free + paid features',
  paid: 'Paid',
  tbd: 'Price TBD',
};

export const EN_VIDEO_CATEGORY: Record<VideoCategory, string> = {
  'ai-coding': 'AI coding',
  gamedev: 'Game development',
  indie: 'Indie games',
  tutorial: 'Tutorials',
};

/** 英文版里用到的中文专有表述（文章分类等）→ 英文；找不到就原样显示 */
export const EN_ARTICLE_CATEGORY: Record<string, string> = {
  开发实践: 'Development practice',
  浏览器扩展: 'Browser extensions',
  'AI 游戏': 'AI games',
  FableMotion: 'FableMotion',
};
