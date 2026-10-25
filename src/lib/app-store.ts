/**
 * 应用商店（P6）的分类法与纯函数：平台、分类、链接类型、平台识别、筛选 / 排序 / 分页、计数格式化。
 * 没有 DOM / Astro 依赖：构建期页面与浏览器 island 共用，Vitest 直接测。
 */
import type { Hue } from './hue';

export const PLATFORMS = [
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'web',
  'cli',
  'browser-ext',
  'ai-bot',
  'mcp',
] as const;
export type PlatformOs = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<PlatformOs, string> = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: '网页版',
  cli: '命令行',
  'browser-ext': '浏览器扩展',
  'ai-bot': 'AI Bot',
  mcp: 'MCP',
};

export const LINK_TYPES = ['direct', 'official', 'store', 'github', 'web'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  direct: '直接下载',
  official: '官方网站',
  store: '官方商店',
  github: 'GitHub Release',
  web: '在线使用',
};

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** 应用分类（slug → 名称）。新增分类在这里加一行，页面与筛选自动出现 */
export const CATEGORIES = {
  creative: '创作工具',
  'browser-tools': '浏览器工具',
  utilities: '效率工具',
  ai: 'AI 工具',
  'dev-tools': '开发工具',
  games: '游戏',
} as const;
export type Category = keyof typeof CATEGORIES;
/** schema.org applicationCategory */
export const CATEGORY_SCHEMA: Record<Category, string> = {
  creative: 'MultimediaApplication',
  'browser-tools': 'BrowserApplication',
  utilities: 'UtilitiesApplication',
  ai: 'UtilitiesApplication',
  'dev-tools': 'DeveloperApplication',
  games: 'GameApplication',
};
/** schema.org operatingSystem 文字 */
export const PLATFORM_SCHEMA: Record<PlatformOs, string> = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  web: 'Web',
  cli: 'Windows, macOS, Linux',
  'browser-ext': 'Chrome, Edge',
  'ai-bot': 'Web',
  mcp: 'Windows, macOS, Linux',
};
export const CATEGORY_IDS = Object.keys(CATEGORIES) as Category[];

// ------------------------------------------------------- AI 工具栏目 /ai/ ----

/** AI 工具分类（/ai/ 的标签页）。一个工具可属于多个分类，第一个是主分类 */
export const AI_CATEGORIES = {
  agent: 'AI Agent',
  'vibe-coding': 'Vibe Coding',
  cli: 'CLI 工具',
  'ai-bot': 'AI Bot',
  mcp: 'MCP',
} as const;
export type AiCategory = keyof typeof AI_CATEGORIES;
export const AI_CATEGORY_IDS = Object.keys(AI_CATEGORIES) as AiCategory[];
/** 分类页的一句话说明（也用作 meta description 的一部分） */
export const AI_CATEGORY_LEDE: Record<AiCategory, string> = {
  agent: '能自己拆解任务、调用工具并持续执行的智能体平台与应用。',
  'vibe-coding': '用自然语言描述需求、由 AI 生成和修改代码的编辑器与在线构建器。',
  cli: '在终端里运行的 AI 编程助手与本地模型工具。',
  'ai-bot': '面向日常对话、写作与问答的 AI 助手应用。',
  mcp: 'Model Context Protocol 服务器：让 AI 助手安全地连接外部工具与数据。',
};
/** schema.org applicationCategory（AI 工具） */
export const AI_CATEGORY_SCHEMA: Record<AiCategory, string> = {
  agent: 'BusinessApplication',
  'vibe-coding': 'DeveloperApplication',
  cli: 'DeveloperApplication',
  'ai-bot': 'UtilitiesApplication',
  mcp: 'DeveloperApplication',
};

/** /ai/ 卡片与客户端筛选用的条目 */
export interface ToolItem {
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  icon: string;
  iconAlt: string;
  /** 图标母版路径（AppIcon / renderCard 据此输出 AVIF / WebP 多尺寸 <picture>） */
  iconSrc: string;
  /** 母版旁有 -64/-128/-256 的 AVIF / WebP 版本 */
  iconVariants: boolean;
  /** 卡片渐变封面色相 */
  hue: Hue;
  categories: AiCategory[];
  platforms: PlatformOs[];
  price: PriceModel;
  priceLabel: string;
  openSource: boolean;
  developer: string;
  order: number;
  url: string;
}

export interface ToolQuery {
  category?: AiCategory | '';
  price?: PriceModel | '';
  /** 只看开源 */
  oss?: boolean;
}

/** 解析 /ai/ 的查询串（非法值忽略） */
export function parseToolQuery(search: string | URLSearchParams): Required<ToolQuery> {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const cat = q.get('cat');
  const price = q.get('price');
  return {
    category: isIn(AI_CATEGORY_IDS, cat) ? (cat as AiCategory) : '',
    price: isIn(PRICE_MODELS, price) ? (price as PriceModel) : '',
    oss: q.get('oss') === '1',
  };
}

export function toolQueryString(q: ToolQuery): string {
  const p = new URLSearchParams();
  if (q.category) p.set('cat', q.category);
  if (q.price) p.set('price', q.price);
  if (q.oss) p.set('oss', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function filterTools<T extends Pick<ToolItem, 'categories' | 'price' | 'openSource'>>(
  items: T[],
  q: ToolQuery,
): T[] {
  return items.filter(
    (t) =>
      (!q.category || t.categories.includes(q.category)) &&
      (!q.price || t.price === q.price) &&
      (!q.oss || t.openSource),
  );
}

export const PRICE_MODELS = ['free', 'freemium', 'paid', 'tbd'] as const;
export type PriceModel = (typeof PRICE_MODELS)[number];
export const PRICE_LABEL: Record<PriceModel, string> = {
  free: '免费',
  freemium: '免费 + 付费功能',
  paid: '付费',
  tbd: '价格待定',
};

export const SORTS = ['new', 'hot', 'rating'] as const;
export type Sort = (typeof SORTS)[number];
export const SORT_LABEL: Record<Sort, string> = { new: '最新', hot: '热门', rating: '评分' };

/** 目录每页条数（静态分页 /apps/page/N/ 与客户端筛选结果共用） */
export const PAGE_SIZE = 6;

// ------------------------------------------------------------ 平台识别 ----

export interface UaHints {
  userAgent: string;
  /** navigator.userAgentData?.platform（Chromium） */
  platform?: string;
  /** iPadOS 13+ 的 Safari 报 Macintosh，用触点数区分 */
  maxTouchPoints?: number;
}

/** 访客当前所在的操作系统；识别不出返回 null */
export function detectOs(
  h: UaHints,
): Extract<PlatformOs, 'ios' | 'android' | 'windows' | 'macos' | 'linux'> | null {
  const ua = h.userAgent || '';
  const p = (h.platform || '').toLowerCase();
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua) || p === 'android') return 'android';
  if (/Macintosh|Mac OS X/i.test(ua) || p === 'macos') return (h.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos';
  if (/Windows/i.test(ua) || p === 'windows') return 'windows';
  if (/Linux|X11|CrOS/i.test(ua) || p === 'linux' || p === 'chrome os') return 'linux';
  return null;
}

/** 桌面浏览器上「哪里都能用」的平台 */
const UNIVERSAL_DESKTOP: PlatformOs[] = ['web', 'browser-ext', 'cli', 'mcp', 'ai-bot'];
/** 系统专属平台（有这些平台时，「没有你的系统版本」的提示才有意义） */
export const NATIVE_OS: PlatformOs[] = ['ios', 'android', 'windows', 'macos', 'linux'];
const UNIVERSAL_MOBILE: PlatformOs[] = ['web', 'ai-bot'];

/**
 * 从应用提供的平台里挑出最适合访客的一个（下载按钮置顶）：
 * 先找同一系统 → 再找通用平台（移动端只考虑网页版 / AI Bot）→ 都没有返回 null（保持原顺序）。
 * 只在有下载地址的平台里挑。
 */
export function pickPlatform(
  available: { os: PlatformOs; url?: string | null }[],
  os: PlatformOs | null,
): PlatformOs | null {
  const usable = available.filter((p) => !!p.url).map((p) => p.os);
  if (!usable.length) return null;
  if (os && usable.includes(os)) return os;
  const mobile = os === 'ios' || os === 'android';
  for (const u of mobile ? UNIVERSAL_MOBILE : UNIVERSAL_DESKTOP) if (usable.includes(u)) return u;
  return null;
}

// ------------------------------------------------------- 目录筛选与排序 ----

/** 目录条目（/apps/catalog.json 的一项；只放列表需要的字段） */
export interface CatalogItem {
  slug: string;
  title: string;
  subtitle: string;
  icon: string;
  iconAlt: string;
  /** 图标母版路径（AppIcon / renderCard 据此输出 AVIF / WebP 多尺寸 <picture>） */
  iconSrc: string;
  /** 母版旁有 -64/-128/-256 的 AVIF / WebP 版本 */
  iconVariants: boolean;
  /** 卡片渐变封面色相 */
  hue: Hue;
  category: Category;
  categoryLabel: string;
  tags: string[];
  platforms: PlatformOs[];
  price: PriceModel;
  priceLabel: string;
  version: string;
  status: string;
  statusClass: string;
  featured: boolean;
  /** YYYY-MM(-DD)；没有更新记录为空串（排在最后） */
  updated: string;
  order: number;
  url: string;
}

export interface AppStats {
  /** 所有平台下载次数之和（真实计数） */
  downloads: number;
  /** 已发布评价条数 */
  reviews: number;
  /** 平均分（无评价为 null） */
  average: number | null;
}

export interface CatalogQuery {
  platform?: PlatformOs | '';
  category?: Category | '';
  price?: PriceModel | '';
  sort?: Sort;
  page?: number;
}

/** 解析 URL 查询串（非法值一律忽略，回到默认） */
export function parseQuery(search: string | URLSearchParams): Required<CatalogQuery> {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const page = Math.trunc(Number(q.get('page')));
  return {
    platform: isIn(PLATFORMS, q.get('platform')) ? (q.get('platform') as PlatformOs) : '',
    category: isIn(CATEGORY_IDS, q.get('category')) ? (q.get('category') as Category) : '',
    price: isIn(PRICE_MODELS, q.get('price')) ? (q.get('price') as PriceModel) : '',
    sort: isIn(SORTS, q.get('sort')) ? (q.get('sort') as Sort) : 'new',
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

export function toQueryString(q: CatalogQuery): string {
  const p = new URLSearchParams();
  if (q.platform) p.set('platform', q.platform);
  if (q.category) p.set('category', q.category);
  if (q.price) p.set('price', q.price);
  if (q.sort && q.sort !== 'new') p.set('sort', q.sort);
  if (q.page && q.page > 1) p.set('page', String(q.page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function filterApps<T extends Pick<CatalogItem, 'platforms' | 'category' | 'price'>>(
  items: T[],
  q: CatalogQuery,
): T[] {
  return items.filter(
    (a) =>
      (!q.platform || a.platforms.includes(q.platform)) &&
      (!q.category || a.category === q.category) &&
      (!q.price || a.price === q.price),
  );
}

/** 默认顺序（最新）：更新日期新的在前；同日按 order */
export function byNewest(
  a: Pick<CatalogItem, 'updated' | 'order'>,
  b: Pick<CatalogItem, 'updated' | 'order'>,
) {
  return b.updated.localeCompare(a.updated) || a.order - b.order;
}

/**
 * 排序。热门 = 真实下载次数；评分 = 平均分（同分评价多的在前），没有评分的排在后面。
 * 没有统计数据（数据库不可达）时 hot / rating 退回「最新」，调用方负责提示。
 */
export function sortApps<T extends Pick<CatalogItem, 'slug' | 'updated' | 'order'>>(
  items: T[],
  sort: Sort,
  stats?: Record<string, AppStats> | null,
): T[] {
  const list = [...items].sort(byNewest);
  if (sort === 'new' || !stats) return list;
  const s = (slug: string): AppStats => stats[slug] ?? { downloads: 0, reviews: 0, average: null };
  if (sort === 'hot') return list.sort((a, b) => s(b.slug).downloads - s(a.slug).downloads || byNewest(a, b));
  return list.sort((a, b) => {
    const x = s(a.slug);
    const y = s(b.slug);
    if (x.average === null && y.average === null) return byNewest(a, b);
    if (x.average === null) return 1;
    if (y.average === null) return -1;
    return y.average - x.average || y.reviews - x.reviews || byNewest(a, b);
  });
}

export interface Paged<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, size = PAGE_SIZE): Paged<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  return { items: items.slice((p - 1) * size, p * size), page: p, pages, total: items.length };
}

/** 静态分页地址：第 1 页是 base 本身，其余 base + page/N/ */
export const pageUrl = (base: string, page: number) => (page <= 1 ? base : `${base}page/${page}/`);

// ------------------------------------------------------------- 统计 ----

/** 数据库行 → 每个应用的统计 */
export function mergeStats(
  downloads: { app: string; downloads: number | string }[],
  reviews: { app: string; reviews: number | string; average: number | string | null }[],
): Record<string, AppStats> {
  const out: Record<string, AppStats> = {};
  const get = (app: string) => (out[app] ??= { downloads: 0, reviews: 0, average: null });
  for (const d of downloads) get(d.app).downloads += Number(d.downloads) || 0;
  for (const r of reviews) {
    const s = get(r.app);
    s.reviews = Number(r.reviews) || 0;
    s.average = r.average === null || r.average === undefined ? null : Number(r.average);
  }
  return out;
}

/** 1234 → 1,234；12345 → 1.2 万（中文习惯） */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 100_000_000) return `${(n / 10_000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')} 万`;
  return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')} 亿`;
}

/** 4.25 → 4.3（App Store 只显示一位小数） */
export const formatRating = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** 星级的可读文本（屏幕阅读器） */
export const ratingLabel = (avg: number, count: number) =>
  `${formatRating(avg)} 分（满分 5 分），${count} 条评价`;

/** sha256 只接受 64 位十六进制 */
export const isSha256 = (s: string) => /^[0-9a-f]{64}$/i.test(s);

/** 外链的域名（中间页显示「即将前往 xxx」） */
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}
