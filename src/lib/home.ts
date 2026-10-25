/**
 * 首页（T6.8 应用商店化）的数据整理：纯函数，只接收内容集合里的真实字段，Vitest 直接测。
 *
 * 原则（docs/PLAN.md T6.8）：
 *  - 只用已有集合里的真实数据；不写评分、下载量、用户数。
 *  - 某个区块没有真实数据时整块不渲染（homeSections() 只返回有内容的区块），不放占位框。
 *  - 排序依据如实标注：AI 工具按编辑顺序（构建期拿不到真实下载数），最近更新按内容里写明的日期。
 */
import {
  AI_CATEGORIES,
  AI_CATEGORY_IDS,
  CATEGORIES,
  CATEGORY_IDS,
  PLATFORMS,
  PLATFORM_LABEL,
  type AiCategory,
  type Category,
  type PlatformOs,
} from './app-store';
import { url } from './routes';
import { AI_CATEGORY_HUE, toolHue, type Hue } from './hue';

export { AI_CATEGORY_HUE };
interface Icon {
  src: string;
  variants: boolean;
}

/** 首页用到的应用字段（CollectionEntry<'apps'> 的子集） */
export interface HomeApp {
  id: string;
  data: {
    title: string;
    subtitle: string;
    tagline: string;
    summary: string;
    icon: Icon;
    hue: Hue;
    developer?: { name: string; type: 'self' | 'third-party' };
    category: Category;
    platforms: { os: PlatformOs }[];
    featured: boolean;
    releaseDate?: string;
    updated?: string;
    version: string;
    order: number;
  };
}
export interface HomeTool {
  id: string;
  data: {
    title: string;
    subtitle: string;
    tagline: string;
    summary: string;
    icon: Icon;
    hue?: Hue;
    developer?: { name: string };
    categories: AiCategory[];
    platforms: { os: PlatformOs }[];
    featured: boolean;
    order: number;
  };
}
export interface HomeVideo {
  id: string;
  data: { featured: boolean; published?: string; order: number };
}
export interface HomeGame {
  id: string;
  data: { title: string; hue: Hue; version: string; date: string; order: number; kind: string };
}
export interface HomeDated {
  id: string;
  data: { date: string; order: number };
}
export interface HomeThread {
  id: string;
  date: string;
  title: string;
  category: string;
  pinned?: boolean;
}

/** 首页 hero 的平台 / 类型快捷入口文字（与目录页的「网页版」「命令行」略有不同，更像入口） */
export const CHIP_LABEL: Partial<Record<PlatformOs, string>> = {
  web: 'Web',
  cli: 'CLI',
  'browser-ext': '浏览器插件',
};

export interface FeaturedItem {
  kind: 'app' | 'tool';
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  icon: Icon;
  hue: Hue;
  /** 「自研应用 · 创作工具」/「AI 工具 · AI Agent」 */
  label: string;
  /** 品牌键（图标墙去重用，见 iconWall） */
  brand: string;
  platforms: string[];
  url: string;
}

/** 编辑精选：featured 的自研应用在前（按 order），其次 featured 的 AI 工具（按 order） */
export function featuredItems(apps: HomeApp[], tools: HomeTool[]): FeaturedItem[] {
  const byOrder = <T extends { data: { order: number } }>(a: T, b: T) => a.data.order - b.data.order;
  return [
    ...apps
      .filter((a) => a.data.featured)
      .sort(byOrder)
      .map((a): FeaturedItem => ({
        kind: 'app',
        slug: a.id,
        title: a.data.title,
        subtitle: a.data.tagline,
        summary: a.data.summary,
        icon: a.data.icon,
        hue: a.data.hue,
        label: `AZ Studio 出品 · ${CATEGORIES[a.data.category]}`,
        brand: appBrand(a),
        platforms: a.data.platforms.map((p) => PLATFORM_LABEL[p.os]),
        url: url.app(a.id),
      })),
    ...tools
      .filter((t) => t.data.featured)
      .sort(byOrder)
      .map((t): FeaturedItem => ({
        kind: 'tool',
        slug: t.id,
        title: t.data.title,
        subtitle: t.data.tagline,
        summary: t.data.summary,
        icon: t.data.icon,
        hue: toolHue(t.data),
        label: `AI 工具 · ${AI_CATEGORIES[t.data.categories[0]]}`,
        brand: toolBrand(t),
        platforms: t.data.platforms.map((p) => PLATFORM_LABEL[p.os]),
        url: url.tool(t.id),
      })),
  ];
}

export interface Chip {
  label: string;
  url: string;
  count: number;
  kind: 'platform' | 'ai';
}

/**
 * hero 快捷入口：平台（有自研应用的平台才有目录页 /apps/platform/<os>/）+ AI 工具分类。
 * 没有条目的平台不出现（目录页本身也不生成），不链到空页面。
 */
export function quickChips(apps: HomeApp[], tools: HomeTool[]): Chip[] {
  const platforms = PLATFORMS.map((os) => ({
    os,
    count: apps.filter((a) => a.data.platforms.some((p) => p.os === os)).length,
  }))
    .filter((p) => p.count > 0 && p.os !== 'ai-bot' && p.os !== 'mcp')
    .map((p): Chip => ({
      label: CHIP_LABEL[p.os] ?? PLATFORM_LABEL[p.os],
      url: url.appPlatform(p.os),
      count: p.count,
      kind: 'platform',
    }));
  const ai = AI_CATEGORY_IDS.map((c) => ({
    c,
    count: tools.filter((t) => t.data.categories.includes(c)).length,
  }))
    .filter((x) => x.count > 0)
    .map((x): Chip => ({ label: AI_CATEGORIES[x.c], url: url.aiCategory(x.c), count: x.count, kind: 'ai' }));
  return [...platforms, ...ai];
}

/** 平台入口里没有条目、因此不显示的平台（报告 / 文档用） */
export function missingPlatforms(apps: HomeApp[]): PlatformOs[] {
  return PLATFORMS.filter(
    (os) => os !== 'ai-bot' && os !== 'mcp' && !apps.some((a) => a.data.platforms.some((p) => p.os === os)),
  );
}

/** AI 工具（编辑顺序）：没有真实下载数据前不做「热度」排行 */
export const toolsByEditorOrder = <T extends HomeTool>(tools: T[], n = 15): T[] =>
  [...tools].sort((a, b) => a.data.order - b.data.order).slice(0, n);

/** 最新上架：只看写了 releaseDate 的应用，新的在前 */
export const newReleases = (apps: HomeApp[], n = 8) =>
  apps
    .filter((a) => !!a.data.releaseDate)
    .sort((a, b) => b.data.releaseDate!.localeCompare(a.data.releaseDate!) || a.data.order - b.data.order)
    .slice(0, n);

export interface UpdateRow {
  kind: 'app' | 'game';
  slug: string;
  title: string;
  /** 「应用 · 创作工具」/「游戏 · AI 游戏」 */
  label: string;
  version: string;
  date: string;
  url: string;
  icon?: Icon;
  hue: Hue;
}

/** 最近更新：应用的 updated 与游戏的 date（都是内容里写明的日期），新的在前；没写日期的不进来 */
export function recentUpdates(apps: HomeApp[], games: HomeGame[], n = 6): UpdateRow[] {
  const rows: (UpdateRow & { order: number })[] = [
    ...apps
      .filter((a) => !!a.data.updated)
      .map((a) => ({
        kind: 'app' as const,
        slug: a.id,
        title: a.data.title,
        label: `应用 · ${CATEGORIES[a.data.category]}`,
        version: a.data.version,
        date: a.data.updated!,
        url: url.app(a.id),
        icon: a.data.icon,
        hue: a.data.hue,
        order: a.data.order,
      })),
    ...games
      .filter((g) => !!g.data.date)
      .map((g) => ({
        kind: 'game' as const,
        slug: g.id,
        title: g.data.title,
        label: `游戏 · ${g.data.kind}`,
        version: g.data.version,
        date: g.data.date,
        url: url.game(g.id),
        hue: g.data.hue,
        order: g.data.order,
      })),
  ];
  return rows
    .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order)
    .slice(0, n)
    .map((r): UpdateRow => {
      const { order, ...row } = r;
      void order;
      return row;
    });
}

export interface CategoryTile {
  kind: 'app' | 'ai';
  id: string;
  name: string;
  count: number;
  url: string;
  icons: { src: string; variants: boolean; alt: string }[];
}

/** 分类入口：应用分类 + AI 工具分类，只列有条目的分类，附真实数量与前 3 个图标 */
export function categoryTiles(apps: HomeApp[], tools: HomeTool[]): CategoryTile[] {
  const sorted = <T extends { data: { order: number } }>(xs: T[]) =>
    [...xs].sort((a, b) => a.data.order - b.data.order);
  const appTiles = CATEGORY_IDS.map((c) => {
    const items = sorted(apps.filter((a) => a.data.category === c));
    return {
      kind: 'app' as const,
      id: c,
      name: CATEGORIES[c],
      count: items.length,
      url: url.appCategory(c),
      icons: items.slice(0, 3).map((a) => ({ ...a.data.icon, alt: '' })),
    };
  });
  const aiTiles = AI_CATEGORY_IDS.map((c) => {
    // 主分类是本分类的排在前面（与 /ai/category/<c>/ 一致）
    const items = sorted(tools.filter((t) => t.data.categories.includes(c))).sort(
      (a, b) => Number(b.data.categories[0] === c) - Number(a.data.categories[0] === c),
    );
    return {
      kind: 'ai' as const,
      id: c,
      name: AI_CATEGORIES[c],
      count: items.length,
      url: url.aiCategory(c),
      icons: items.slice(0, 3).map((t) => ({ ...t.data.icon, alt: '' })),
    };
  });
  return [...appTiles, ...aiTiles].filter((t) => t.count > 0);
}

/** 精选视频：featured 的在前（按 order），再按核实过的发布时间补到 n 个（没有发布时间的排最后） */
export function homeVideos<T extends HomeVideo>(videos: T[], n = 8): T[] {
  const featured = videos.filter((v) => v.data.featured).sort((a, b) => a.data.order - b.data.order);
  const rest = videos
    .filter((v) => !v.data.featured)
    .sort(
      (a, b) => (b.data.published ?? '').localeCompare(a.data.published ?? '') || a.data.order - b.data.order,
    );
  return [...featured, ...rest].slice(0, n);
}

/** 按 date 字段倒序（YYYY-MM 或 YYYY-MM-DD），同日按 order */
export const latestByDate = <T extends HomeDated>(xs: T[], n: number): T[] =>
  [...xs].sort((a, b) => b.data.date.localeCompare(a.data.date) || a.data.order - b.data.order).slice(0, n);

/** 论坛最新话题（构建期可用的种子主题）：新的在前 */
export const latestThreads = <T extends HomeThread>(threads: T[], n = 5): T[] =>
  [...threads].sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);

/** 首页区块（顺序即页面顺序）。hero、关于作者与订阅条总是显示：它们不依赖集合数据 */
/** 首页区块（T9.11：≤ 8 个；分类 / 游戏 / 作品 / 论坛 / 关于 / 订阅并入「更多内容」） */
export const HOME_SECTIONS = [
  'featured',
  'apps',
  'new',
  'ai',
  'updates',
  'videos',
  'articles',
  'more',
] as const;
export type HomeSectionId = (typeof HOME_SECTIONS)[number];

export type HomeCounts = Record<HomeSectionId, number>;

/** 有真实数据的区块（按页面顺序）；条目数为 0 的区块整块隐藏 */
export const homeSections = (counts: HomeCounts): HomeSectionId[] =>
  HOME_SECTIONS.filter((id) => counts[id] > 0);

/** 结构化数据：编辑精选的 ItemList */
export function featuredItemList(items: FeaturedItem[], absUrl: (p: string) => string) {
  return {
    '@type': 'ItemList',
    '@id': `${absUrl('/')}#featured`,
    name: '编辑精选',
    itemListOrder: 'https://schema.org/ItemListUnordered',
    numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.title,
      url: absUrl(it.url),
    })),
  };
}

/** hero「试试」关键词：真实、有意义的词（每个都至少命中一条站内内容，单元测试校验） */
export const TRY_QUERIES = ['动画编辑器', 'Cursor', '塔防', 'MCP'] as const;

export interface WallIcon {
  title: string;
  icon: Icon;
  href: string;
  /** 品牌键：同一品牌（如 OpenAI 的 ChatGPT 与 Codex）只出现一次；自研应用用 self:<slug> */
  brand: string;
}

/** 开发者名 → 品牌键：去掉括号里的补充（「GitHub（Microsoft）」→ github） */
export const brandKey = (name: string) =>
  name
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim()
    .toLowerCase();

/**
 * hero 图标墙：按候选顺序取 n 个，同一链接、同一图标文件、同一品牌、同一图片内容（fingerprint）只取第一个，
 * 保证墙上没有重复的 logo（ChatGPT 与 Codex CLI 用的是同一个 OpenAI 标志）。
 */
export function iconWall(
  cands: WallIcon[],
  n = 12,
  fingerprint: (src: string) => string = (s) => s,
): WallIcon[] {
  const seen = new Set<string>();
  const out: WallIcon[] = [];
  for (const c of cands) {
    const keys = [`href:${c.href}`, `src:${c.icon.src}`, `brand:${c.brand}`, `fp:${fingerprint(c.icon.src)}`];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}

export const appBrand = (a: HomeApp) =>
  a.data.developer?.type === 'third-party' ? brandKey(a.data.developer.name) : `self:${a.id}`;
export const toolBrand = (t: HomeTool) =>
  t.data.developer ? brandKey(t.data.developer.name) : `tool:${t.id}`;
