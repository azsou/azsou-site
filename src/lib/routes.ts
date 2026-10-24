/** 唯一的 URL 生成处：所有页面链接都从这里出，方便以后改路由。 */
export const url = {
  home: () => '/',
  apps: () => '/apps/',
  app: (slug: string) => `/apps/${slug}/`,
  appsPage: (page: number) => (page <= 1 ? '/apps/' : `/apps/page/${page}/`),
  appCategory: (cat: string) => `/apps/category/${cat}/`,
  appPlatform: (os: string) => `/apps/platform/${os}/`,
  /** 下载中转页（外链提示 + 计数）；不进 sitemap、noindex */
  go: (slug: string, os: string) => `/go/${slug}/${os}/`,
  /** AI 工具栏目（第三方工具，只链官方地址） */
  ai: () => '/ai/',
  tool: (slug: string) => `/ai/${slug}/`,
  aiCategory: (cat: string) => `/ai/category/${cat}/`,
  rss: () => '/rss.xml',
  games: () => '/games/',
  game: (slug: string) => `/games/${slug}/`,
  articles: () => '/articles/',
  article: (slug: string) => `/articles/${slug}/`,
  works: () => '/works/',
  work: (slug: string) => `/works/${slug}/`,
  tags: () => '/tags/',
  tag: (tag: string) => `/tags/${tag}/`,
  archive: () => '/archive/',
  search: (q?: string) => (q ? `/search/?q=${encodeURIComponent(q)}` : '/search/'),
  forum: () => '/forum/',
  forumCategory: (id: string) => `/forum/${id}/`,
  /** 种子主题静态生成；数据库主题走静态外壳 + 客户端渲染（见 docs/PLAN.md P3 设计说明） */
  forumThread: (id: string) =>
    /^t-[a-z0-9-]+$/.test(id) ? `/forum/t/${id}/` : `/forum/t/?id=${encodeURIComponent(id)}`,
  forumNew: (category?: string) =>
    category ? `/forum/new/?cat=${encodeURIComponent(category)}` : '/forum/new/',
  user: (id: string) => `/u/?id=${encodeURIComponent(id)}`,
  bookmarks: () => '/bookmarks/',
  notifications: () => '/notifications/',
  login: (next?: string) => (next ? `/login/?next=${encodeURIComponent(next)}` : '/login/'),
  admin: (section = '') => (section ? `/admin/${section}/` : '/admin/'),
  adminUser: (id: string) => `/admin/users/view/?id=${encodeURIComponent(id)}`,
} as const;

/** 评论 page_key 的格式（与数据库 comments_page_key_check 一致；tool: 由迁移 0013 加入） */
export const PAGE_KEY_RE = /^(article|game|work|project|tool):([a-z0-9-]{1,60})$/;

/** 评论 page_key（V72：article:/game:/work:/project:<slug>；v2 新增 tool:<slug>）→ 页面地址；无法识别返回 null */
export function pageKeyUrl(pageKey: string): string | null {
  const m = PAGE_KEY_RE.exec(pageKey);
  if (!m) return null;
  const [, scope, slug] = m;
  if (scope === 'project') return url.app(slug);
  if (scope === 'tool') return url.tool(slug);
  return url[scope as 'article' | 'game' | 'work'](slug);
}

export type RelatedType = 'app' | 'game' | 'article' | 'work';
export const relatedUrl = (type: RelatedType, slug: string) => url[type](slug);

/** 生成式素材对应的 PNG 分享图（构建期生成，见 src/pages/og/art/[slot].png.ts） */
export const ogArt = (slot: string) => `/og/art/${slot}.png`;
