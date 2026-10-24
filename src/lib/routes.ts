/** 唯一的 URL 生成处：所有页面链接都从这里出，方便以后改路由。 */
export const url = {
  home: () => '/',
  apps: () => '/apps/',
  app: (slug: string) => `/apps/${slug}/`,
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
} as const;

export type RelatedType = 'app' | 'game' | 'article' | 'work';
export const relatedUrl = (type: RelatedType, slug: string) => url[type](slug);

/** 生成式素材对应的 PNG 分享图（构建期生成，见 src/pages/og/art/[slot].png.ts） */
export const ogArt = (slot: string) => `/og/art/${slot}.png`;
