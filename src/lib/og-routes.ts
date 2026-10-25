/**
 * 按页面类型的 OG 图路径（T9.4，构建期生成，见 src/pages/og/[...slug].png.ts）。
 * 详情页传 ogFor(类型, slug, lang)；其余页面由 Base 按路径落到所属栏目的 ogSection()。
 */
export type OgType = 'app' | 'ai' | 'game' | 'video' | 'article' | 'work' | 'forum';
export const ogFor = (type: OgType, slug: string, lang: 'zh' | 'en' = 'zh') =>
  `/og/${lang === 'en' ? 'en/' : ''}${type}/${slug}.png`;

export const OG_SECTIONS: Record<
  string,
  { title: string; tagline: string; icons: 'apps' | 'tools' | 'mixed' }
> = {
  home: { title: 'AZ Studio', tagline: '独立应用、AI 工具、游戏与开发笔记', icons: 'mixed' },
  apps: { title: '应用', tagline: 'AZ Studio 出品与精选应用', icons: 'apps' },
  ai: { title: 'AI 工具', tagline: '编程智能体、模型客户端与 MCP 服务器', icons: 'tools' },
  videos: { title: '视频', tagline: 'AI 编程与游戏开发视频精选', icons: 'tools' },
  games: { title: '游戏', tagline: '可试玩的小游戏与技术原型', icons: 'mixed' },
  articles: { title: '文章', tagline: '开发笔记与技术长文', icons: 'mixed' },
  works: { title: '作品', tagline: '设计稿、原型与创作实验', icons: 'apps' },
  forum: { title: '论坛', tagline: '围绕站内项目与技术的讨论', icons: 'mixed' },
  site: { title: 'AZ Studio', tagline: '独立应用、AI 工具、游戏与开发笔记', icons: 'mixed' },
  'en-home': { title: 'AZ Studio', tagline: 'Indie apps, AI tools, games and dev notes', icons: 'mixed' },
  'en-apps': { title: 'Apps', tagline: 'Apps by AZ Studio and curated picks', icons: 'apps' },
  'en-ai': { title: 'AI Tools', tagline: 'Coding agents, model clients and MCP servers', icons: 'tools' },
  'en-videos': { title: 'Videos', tagline: 'Curated AI coding and game dev videos', icons: 'tools' },
  'en-games': { title: 'Games', tagline: 'Playable small games and tech prototypes', icons: 'mixed' },
  'en-articles': { title: 'Articles', tagline: 'Dev notes and long-form write-ups', icons: 'mixed' },
  'en-site': { title: 'AZ Studio', tagline: 'Indie apps, AI tools, games and dev notes', icons: 'mixed' },
};

/** 页面路径 → 所属栏目的 OG 图 */
export function ogSection(path: string): string {
  const en = path.startsWith('/en/') || path === '/en';
  const rest = en ? path.replace(/^\/en/, '') : path;
  const seg = rest.split('/')[1] ?? '';
  const id = seg === '' ? 'home' : seg === 'tags' ? 'site' : seg;
  const key = en ? `en-${id}` : id;
  return `/og/s/${OG_SECTIONS[key] ? key : en ? 'en-site' : 'site'}.png`;
}
