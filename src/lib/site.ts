export const SITE = {
  name: 'AZ Studio',
  url: 'https://azsou.com',
  locale: 'zh_CN',
  lang: 'zh-CN',
  title: 'AZ Studio · 个人技术社区与产品档案',
  description:
    '个人技术社区、产品档案与创作实验室。真实项目、版本记录、测试环境与最后核对日期，不伪造评分与下载量。',
  author: { name: 'Randy Hopkins', url: 'https://azsou.com/about/' },
  ogImage: '/og-image.png',
} as const;

export interface NavItem {
  href: string;
  label: string;
  /** 底部 Tab（移动端）显示的短名，没有就不进 Tab */
  tab?: string;
  icon?: string;
}

export const NAV: NavItem[] = [
  { href: '/', label: '首页', tab: '首页', icon: 'home' },
  { href: '/apps/', label: '应用', tab: '应用', icon: 'apps' },
  { href: '/ai/', label: 'AI 工具' },
  { href: '/videos/', label: '视频' },
  { href: '/games/', label: '游戏', tab: '游戏', icon: 'games' },
  { href: '/articles/', label: '文章', tab: '文章', icon: 'articles' },
  { href: '/works/', label: '作品', icon: 'works' },
  { href: '/forum/', label: '论坛', tab: '论坛', icon: 'forum' },
];

export const FOOTER = [
  {
    title: '发现',
    links: [
      { href: '/apps/', label: '应用目录' },
      { href: '/ai/', label: 'AI 工具' },
      { href: '/videos/', label: '视频' },
      { href: '/games/', label: '游戏与 Demo' },
      { href: '/articles/', label: '原创文章' },
      { href: '/works/', label: '作品与视频' },
      { href: '/tags/', label: '标签' },
      { href: '/archive/', label: '归档' },
    ],
  },
  {
    title: '项目',
    links: [
      { href: '/apps/fablemotion/', label: 'FableMotion' },
      { href: '/games/emberdeep/', label: 'EMBERDEEP' },
      { href: '/apps/image-atlas-pro/', label: 'Image Atlas Pro' },
      { href: '/apps/capture-kit/', label: 'Capture Kit' },
      { href: '/changelog/', label: '更新日志' },
      { href: '/roadmap/', label: '路线图' },
    ],
  },
  {
    title: '站点与合规',
    links: [
      { href: '/about/', label: '关于作者' },
      { href: '/contact/', label: '联系' },
      { href: '/guestbook/', label: '留言板' },
      { href: '/links/', label: '友情链接' },
      { href: '/privacy/', label: '隐私政策' },
      { href: '/terms/', label: '使用条款' },
      { href: '/editorial/', label: '编辑规范' },
      { href: '/rss.xml', label: 'RSS' },
    ],
  },
];

/** 官方内容在 Git 里维护：后台「官方内容」页链接到 GitHub 编辑页（合并到 main 后生效的分支） */
export const REPO = {
  url: 'https://github.com/azsou/azsou-site',
  branch: 'main',
} as const;
export const githubEdit = (path: string) => `${REPO.url}/edit/${REPO.branch}/${path.replace(/^\.?\//, '')}`;
export const githubHistory = (path: string) =>
  `${REPO.url}/commits/${REPO.branch}/${path.replace(/^\.?\//, '')}`;
