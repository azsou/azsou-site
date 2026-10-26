/**
 * 商店条目统一模型（P10 T10.1 / T10.2）：应用、AI 工具、游戏都整理成同一套字段，
 * AppRow / AppTile / AppMini、货架、排行与列表页共用。纯函数，Vitest 直接测。
 *
 * 原则（站长决定，2026-10-26）：
 *  - 只放真实元数据：版本、大小、更新日期、平台、类型徽标、许可 / 价格。没有就整项省略，
 *    不输出「N/A」「—」「未知」之类的占位；
 *  - 没有真实评分 / 热度：不出现评分字段，排序用「编辑推荐」（order）；
 *  - 主操作指向官方渠道（经 /go/ 中转页：外链提示 + 真实计数）或站内试玩，不指向自托管文件。
 */
import {
  AI_CATEGORIES,
  CATEGORIES,
  LINK_TYPE_LABEL,
  PLATFORM_LABEL,
  PRICE_LABEL,
  type AiCategory,
  type Category,
  type LinkType,
  type PlatformOs,
  type PriceModel,
} from './app-store';
import { toolHue, type Hue } from './hue';
import { url } from './routes';

export type EntryType = 'app' | 'ai' | 'game';
export const TYPE_LABEL: Record<EntryType, string> = { app: '应用', ai: 'AI 工具', game: '游戏' };

export interface EntryAction {
  /** 按钮文字：获取 / 官网 / 商店 / GitHub / 打开 / 试玩 / 了解 */
  label: string;
  href: string;
  /** true = 去往站外官方渠道（经 /go/ 中转页） */
  outbound: boolean;
}

/** 元数据：全部可选，没有真实值就不写这个键 */
export interface EntryMeta {
  version?: string;
  size?: string;
  /** YYYY-MM 或 YYYY-MM-DD */
  updatedAt?: string;
  /** 平台显示名（「网页版」「Windows」） */
  platforms?: string[];
  /** 许可全文（如「Apache-2.0」「专有软件」） */
  license?: string;
  /** 价格（「免费」「免费 + 付费功能」「¥18」） */
  pricing?: string;
  openSource?: boolean;
}
export const META_KEYS = ['version', 'size', 'updatedAt', 'platforms', 'license', 'pricing'] as const;
export type MetaKey = (typeof META_KEYS)[number];

export interface StoreEntry {
  type: EntryType;
  typeLabel: string;
  slug: string;
  title: string;
  /** 卡片一句话（tagline，6–16） */
  subtitle: string;
  developer?: string;
  /** 开发者全称（同开发者导流区按它匹配） */
  developerName?: string;
  href: string;
  /** 有图标的条目（应用 / AI 工具）；游戏没有图标，用 hue + 几何兜底 */
  icon?: { src: string; variants: boolean };
  hue: Hue;
  /** 主分类（列表页左栏 / 分类图标墙） */
  category: { id: string; label: string };
  /** 全部分类 id（AI 工具可属于多个） */
  categories: string[];
  platformIds: PlatformOs[];
  meta: EntryMeta;
  action: EntryAction;
  /** 编辑顺序（越小越靠前） */
  order: number;
  pinyin: string;
}

type Icon = { src: string; variants: boolean };
type Platform = { os: PlatformOs; version?: string; size?: string; url?: string; linkType: LinkType };

/** 应用（CollectionEntry<'apps'> 的子集） */
export interface StoreAppInput {
  id: string;
  data: {
    title: string;
    tagline: string;
    icon: Icon;
    hue: Hue;
    developer: { name: string; short?: string; type: 'self' | 'third-party' };
    category: Category;
    platforms: Platform[];
    price: { model: PriceModel; amount?: string };
    license: string;
    openSource: boolean;
    version: string;
    updated?: string;
    size?: string;
    changelog?: { date: string }[];
    order: number;
    pinyin?: string;
  };
}
export interface StoreToolInput {
  id: string;
  data: {
    title: string;
    tagline: string;
    icon: Icon;
    hue?: Hue;
    developer: { name: string; short?: string };
    categories: AiCategory[];
    platforms: Platform[];
    price: { model: PriceModel; amount?: string };
    license: string;
    openSource: boolean;
    version?: string;
    updated?: string;
    size?: string;
    order: number;
    pinyin?: string;
  };
}
export interface StoreGameInput {
  id: string;
  data: {
    title: string;
    genre: string;
    kind: string;
    hue: Hue;
    version: string;
    date: string;
    order: number;
    pinyin?: string;
    playUrl?: string;
    platforms?: PlatformOs[];
    size?: string;
    license?: string;
  };
}

const clean = (s?: string) => {
  const v = s?.trim();
  // 「随官方更新」「—」之类不是真实值
  return v && !/^(—|-|n\/?a|未知|暂无)$/i.test(v) ? v : undefined;
};
/** 去掉 undefined / 空数组的键：元数据里只留真实值 */
function compact(m: EntryMeta): EntryMeta {
  const out: EntryMeta = {};
  for (const [k, v] of Object.entries(m) as [keyof EntryMeta, EntryMeta[keyof EntryMeta]][]) {
    if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
const pricing = (p: { model: PriceModel; amount?: string }) =>
  p.model === 'paid' && p.amount ? p.amount : p.model === 'tbd' ? undefined : PRICE_LABEL[p.model];
const firstSize = (ps: Platform[]) => ps.map((p) => clean(p.size)).find(Boolean);

/** 官方渠道按钮文字（按链接类型） */
export const ACTION_LABEL: Record<LinkType, string> = {
  direct: '下载',
  official: '官网',
  store: '商店',
  github: 'GitHub',
  web: '打开',
};

function platformAction(slug: string, ps: Platform[], own: boolean): EntryAction | null {
  const p = ps.find((x) => !!x.url);
  if (!p) return null;
  return { label: own ? '获取' : ACTION_LABEL[p.linkType], href: url.go(slug, p.os), outbound: true };
}

export function fromApp(a: StoreAppInput): StoreEntry {
  const d = a.data;
  const own = d.developer.type === 'self';
  return {
    type: 'app',
    typeLabel: TYPE_LABEL.app,
    slug: a.id,
    title: d.title,
    subtitle: d.tagline,
    developer: d.developer.short ?? d.developer.name,
    developerName: d.developer.name,
    href: url.app(a.id),
    icon: d.icon,
    hue: d.hue,
    category: { id: d.category, label: CATEGORIES[d.category] },
    categories: [d.category],
    platformIds: d.platforms.map((p) => p.os),
    meta: compact({
      version: clean(d.version),
      size: clean(d.size) ?? firstSize(d.platforms),
      updatedAt: clean(d.updated) ?? clean(d.changelog?.[0]?.date),
      platforms: d.platforms.map((p) => PLATFORM_LABEL[p.os]),
      license: clean(d.license),
      pricing: pricing(d.price),
      openSource: d.openSource,
    }),
    action: platformAction(a.id, d.platforms, own) ?? {
      label: '了解',
      href: url.app(a.id),
      outbound: false,
    },
    order: d.order,
    pinyin: d.pinyin ?? '',
  };
}

export function fromTool(t: StoreToolInput): StoreEntry {
  const d = t.data;
  return {
    type: 'ai',
    typeLabel: TYPE_LABEL.ai,
    slug: t.id,
    title: d.title,
    subtitle: d.tagline,
    developer: d.developer.short ?? d.developer.name,
    developerName: d.developer.name,
    href: url.tool(t.id),
    icon: d.icon,
    hue: toolHue(d),
    category: { id: d.categories[0], label: AI_CATEGORIES[d.categories[0]] },
    categories: d.categories,
    platformIds: d.platforms.map((p) => p.os),
    meta: compact({
      version: clean(d.version),
      size: clean(d.size) ?? firstSize(d.platforms),
      updatedAt: clean(d.updated),
      platforms: d.platforms.map((p) => PLATFORM_LABEL[p.os]),
      license: clean(d.license),
      pricing: pricing(d.price),
      openSource: d.openSource,
    }),
    action: platformAction(t.id, d.platforms, false) ?? {
      label: '了解',
      href: url.tool(t.id),
      outbound: false,
    },
    order: d.order,
    pinyin: d.pinyin ?? '',
  };
}

export function fromGame(g: StoreGameInput): StoreEntry {
  const d = g.data;
  return {
    type: 'game',
    typeLabel: TYPE_LABEL.game,
    slug: g.id,
    title: d.title,
    subtitle: d.genre,
    developer: undefined,
    href: url.game(g.id),
    hue: d.hue,
    category: { id: d.kind, label: d.kind },
    categories: [d.kind],
    platformIds: d.platforms ?? [],
    meta: compact({
      version: clean(d.version),
      size: clean(d.size),
      updatedAt: clean(d.date),
      platforms: (d.platforms ?? []).map((p) => PLATFORM_LABEL[p]),
      license: clean(d.license),
    }),
    // 有试玩地址才是「试玩」；否则去详情页（详情页的主按钮按状态决定，T9.12）
    action: d.playUrl
      ? { label: '试玩', href: d.playUrl, outbound: /^https:/.test(d.playUrl) }
      : { label: '了解', href: url.game(g.id), outbound: false },
    order: d.order,
    pinyin: d.pinyin ?? '',
  };
}

/** 元数据文字（按显示优先级）；只返回有值的项。fields 控制显示哪些、顺序如何 */
export function metaParts(
  e: StoreEntry,
  fields: readonly (MetaKey | 'category')[] = ['category', 'version', 'updatedAt', 'pricing'],
  fmtDate: (d: string) => string = (d) => d,
): string[] {
  const m = e.meta;
  const out: string[] = [];
  for (const f of fields) {
    if (f === 'category') out.push(e.category.label);
    else if (f === 'version' && m.version) out.push(versionText(m.version));
    else if (f === 'updatedAt' && m.updatedAt) out.push(fmtDate(m.updatedAt));
    else if (f === 'platforms' && m.platforms) out.push(m.platforms.join(' / '));
    else if (f === 'size' && m.size) out.push(m.size);
    else if (f === 'pricing' && m.pricing) out.push(m.pricing);
    else if (f === 'license' && m.license) out.push(m.license);
  }
  return out;
}

/** 版本号看起来像「1.2」「0.6」「v2.3.1」时才加 v 前缀；「S3 Candidate」之类原样 */
export const versionText = (v: string) =>
  /^v?\d+(\.\d+)*([-+.][\w.]+)?$/i.test(v) ? `v${v.replace(/^v/i, '')}` : v;

/** 排序（列表页 / 货架）：new = 更新日期新的在前（没日期的排后）、name = 名称（拼音首字母优先）、editor = 编辑顺序 */
export const ENTRY_SORTS = ['new', 'name', 'editor'] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];
export const ENTRY_SORT_LABEL: Record<EntrySort, string> = { new: '最新', name: '名称', editor: '编辑推荐' };

export const nameKey = (e: Pick<StoreEntry, 'title' | 'pinyin'>) => (e.pinyin || e.title).toLowerCase();

export function sortEntries<T extends Pick<StoreEntry, 'title' | 'pinyin' | 'order' | 'meta'>>(
  xs: T[],
  sort: EntrySort,
): T[] {
  const list = [...xs];
  if (sort === 'editor') return list.sort((a, b) => a.order - b.order);
  if (sort === 'name')
    return list.sort((a, b) => nameKey(a).localeCompare(nameKey(b), 'zh-CN') || a.order - b.order);
  return list.sort(
    (a, b) => (b.meta.updatedAt ?? '').localeCompare(a.meta.updatedAt ?? '') || a.order - b.order,
  );
}

/** 最新更新货架：只收有真实更新日期的条目 */
export const latestUpdated = (xs: StoreEntry[], n: number) =>
  sortEntries(
    xs.filter((x) => !!x.meta.updatedAt),
    'new',
  ).slice(0, n);

/** 字段填充统计（T10.2 报告）：每个字段有值 / 省略各多少条 */
export function fillReport(xs: StoreEntry[]): Record<MetaKey, { filled: number; omitted: number }> {
  const r = {} as Record<MetaKey, { filled: number; omitted: number }>;
  for (const k of META_KEYS) {
    const filled = xs.filter((x) => x.meta[k] !== undefined).length;
    r[k] = { filled, omitted: xs.length - filled };
  }
  return r;
}

/** 列表页 / 客户端排序用的 data-* 属性 */
export const sortAttrs = (e: StoreEntry) => ({
  'data-sort-new': e.meta.updatedAt ?? '',
  'data-sort-name': nameKey(e),
  'data-sort-editor': String(e.order),
});

export { LINK_TYPE_LABEL };

// ------------------------------------------------------------ 详情页（P10 PR G） ----

/** 详情页指标条的一格：只放有真实值的字段（T10.11） */
export interface DetailMetric {
  key: MetaKey;
  label: string;
  value: string;
}
export const METRIC_LABEL: Record<MetaKey, string> = {
  version: '版本',
  size: '大小',
  updatedAt: '更新',
  platforms: '平台',
  license: '许可',
  pricing: '价格',
};
/** 指标条：版本｜大小｜更新｜平台｜价格｜许可（不放评分；没值的整格省略） */
export function detailMetrics(e: StoreEntry, fmtDate: (d: string) => string = (d) => d): DetailMetric[] {
  const m = e.meta;
  const out: DetailMetric[] = [];
  const push = (key: MetaKey, value?: string) => value && out.push({ key, label: METRIC_LABEL[key], value });
  push('version', m.version && versionText(m.version));
  push('size', m.size);
  push('updatedAt', m.updatedAt && fmtDate(m.updatedAt));
  push('platforms', m.platforms?.join(' / '));
  push('pricing', m.pricing);
  push(
    'license',
    m.license && (m.openSource && !/开源/.test(m.license) ? `${m.license}（开源）` : m.license),
  );
  return out;
}

/** 同类替代（T10.13）：同主分类优先，其次共享分类；按编辑顺序 */
export function alternatives(self: StoreEntry, all: StoreEntry[], n = 5): StoreEntry[] {
  return all
    .filter((x) => x.slug !== self.slug && x.type === self.type)
    .map((x) => ({
      x,
      score:
        (x.category.id === self.category.id ? 10 : 0) +
        x.categories.filter((c) => self.categories.includes(c)).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.x.order - b.x.order)
    .slice(0, n)
    .map((r) => r.x);
}

/** 同开发者（T10.13）：开发者全称相同的其它条目（跨应用 / AI 工具） */
export function sameDeveloper(self: StoreEntry, all: StoreEntry[], n = 5): StoreEntry[] {
  if (!self.developerName) return [];
  return all
    .filter((x) => x.slug !== self.slug && x.developerName === self.developerName)
    .sort((a, b) => a.order - b.order)
    .slice(0, n);
}

/** 编辑推荐（T10.13）：按编辑顺序，排除自身与已在其它导流区出现的条目 */
export function editorPicks(selfSlug: string, all: StoreEntry[], exclude: StoreEntry[], n = 5): StoreEntry[] {
  const skip = new Set([selfSlug, ...exclude.map((x) => x.slug)]);
  return sortEntries(
    all.filter((x) => !skip.has(x.slug)),
    'editor',
  ).slice(0, n);
}

/**
 * 简介折叠（T10.12）：把可信 HTML 正文按顶层块切成「首段可见」+「其余折叠」两部分（服务端切，无 JS、无布局移动）。
 * 块数 ≤ keep + 1 或正文很短时不折叠（rest = ''）。
 */
export function splitIntro(html: string, keep = 2, minChars = 360): { lead: string; rest: string } {
  const blocks: string[] = [];
  const re = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  const VOID = /^(br|hr|img|input|meta|link|source|wbr)$/i;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1];
    if (VOID.test(tag) || m[0].endsWith('/>')) {
      if (depth === 0) {
        blocks.push(html.slice(start, re.lastIndex));
        start = re.lastIndex;
      }
      continue;
    }
    if (m[0][1] === '/') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        blocks.push(html.slice(start, re.lastIndex));
        start = re.lastIndex;
      }
    } else depth++;
  }
  const tail = html.slice(start);
  if (tail.trim()) blocks.push(tail);
  const parts = blocks.map((b) => b.trim()).filter(Boolean);
  const text = html.replace(/<[^>]+>/g, '').trim();
  if (parts.length <= keep + 1 || text.length < minChars) return { lead: html, rest: '' };
  return { lead: parts.slice(0, keep).join('\n'), rest: parts.slice(keep).join('\n') };
}

/**
 * 游戏状态与按钮一致（T10.15）：没有试玩地址也没有演示视频时，类型 / 状态里不能出现「可玩 / 可试用」之类的说法。
 * tests/unit/store.test.ts 对全部游戏内容断言这一点。
 */
export const PLAY_CLAIM = /可玩|可试用|试玩|playable|try it/i;
export const gamePlayable = (d: { playUrl?: string; demoVideo?: string }) => !!(d.playUrl || d.demoVideo);
export function gamePlayClaims(d: {
  kind: string;
  status: string;
  playUrl?: string;
  demoVideo?: string;
  en?: { kind?: string; status?: string };
}): string[] {
  if (gamePlayable(d)) return [];
  return [d.kind, d.status, d.en?.kind ?? '', d.en?.status ?? ''].filter((s) => PLAY_CLAIM.test(s));
}
