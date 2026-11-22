import { SITE } from './site';
import { sameAs } from './social';
import { toDate } from './dates';

export const abs = (path: string) => new URL(path, SITE.url).toString();

type Json = Record<string, unknown>;

export interface Crumb {
  name: string;
  path: string;
}

const AUTHOR_REF = { '@id': `${SITE.url}/#author` };
const ORG_REF = { '@id': `${SITE.url}/#org` };
/** 作者内联写出 name / url（Google 的 Article 要求 author.name；只给 @id 引用时部分校验器读不到） */
const AUTHOR_INLINE = {
  '@type': 'Person',
  '@id': `${SITE.url}/#author`,
  name: SITE.author.name,
  url: SITE.author.url,
};
const iso = (d: string) => toDate(d).toISOString();

export const person = (): Json => ({
  '@type': 'Person',
  '@id': `${SITE.url}/#author`,
  name: SITE.author.name,
  url: SITE.author.url,
  // 只放核实过的站外账号（src/data/social.json，T7.4）
  ...(sameAs().length ? { sameAs: sameAs() } : {}),
});

/** 站点运营方（全站每页都带；logo 为 512 px PNG） */
export const organization = (): Json => ({
  '@type': 'Organization',
  '@id': `${SITE.url}/#org`,
  name: SITE.name,
  url: `${SITE.url}/`,
  logo: { '@type': 'ImageObject', url: abs('/icons/icon-512.png'), width: 512, height: 512 },
  founder: AUTHOR_REF,
});

export const website = (): Json => ({
  '@type': 'WebSite',
  '@id': `${SITE.url}/#website`,
  name: SITE.name,
  url: `${SITE.url}/`,
  inLanguage: SITE.lang,
  description: SITE.description,
  author: AUTHOR_REF,
  publisher: ORG_REF,
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${SITE.url}/search/?q={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
});

/** 每页一个 WebPage 节点：写明本页语言（T7.6，中文 zh-CN / 英文 en） */
export const webPage = (p: { path: string; name: string; inLanguage: string }): Json => ({
  '@type': 'WebPage',
  '@id': `${abs(p.path)}#webpage`,
  url: abs(p.path),
  name: p.name,
  inLanguage: p.inLanguage,
  isPartOf: { '@id': `${SITE.url}/#website` },
});

export const breadcrumbs = (items: Crumb[]): Json => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: c.name,
    item: abs(c.path),
  })),
});

export function article(a: {
  title: string;
  description: string;
  path: string;
  date: string;
  modified: string;
  image: string;
  section: string;
  keywords: string[];
}): Json {
  return {
    '@type': 'BlogPosting',
    headline: a.title,
    description: a.description,
    url: abs(a.path),
    mainEntityOfPage: abs(a.path),
    datePublished: iso(a.date),
    dateModified: iso(a.modified),
    image: abs(a.image),
    articleSection: a.section,
    keywords: a.keywords.join(','),
    inLanguage: SITE.lang,
    isPartOf: { '@id': `${SITE.url}/#website` },
    author: AUTHOR_INLINE,
    publisher: ORG_REF,
  };
}

/** 价格文字 → Offer：只认「¥18」「$4.99」「18 元」这类明确的金额；其余（按量计费、订阅、待定）不写 offers */
export function offerFrom(price: { model: string; amount?: string } | undefined): Json | undefined {
  if (!price) return undefined;
  if (price.model === 'free') return { '@type': 'Offer', price: '0', priceCurrency: 'CNY' };
  if (price.model !== 'paid' || !price.amount) return undefined;
  const m = /^\s*(¥|￥|\$|US\$|€)?\s*(\d+(?:\.\d{1,2})?)\s*(元|CNY|USD|EUR)?\s*$/i.exec(price.amount);
  if (!m || (!m[1] && !m[3])) return undefined;
  const cur = (m[1] ?? m[3]).toUpperCase();
  const currency = /^(¥|￥|元|CNY)$/.test(cur) ? 'CNY' : /^(\$|US\$|USD)$/.test(cur) ? 'USD' : 'EUR';
  return { '@type': 'Offer', price: String(Number(m[2])), priceCurrency: currency };
}

/** 真实评价汇总（构建期数据里条数 ≥ 1 才写；没有就不写——不伪造评分） */
export interface RatingSummary {
  value: number;
  count: number;
}
export function aggregateRating(r: RatingSummary | undefined): Json | undefined {
  if (!r || !Number.isInteger(r.count) || r.count < 1 || !(r.value >= 1 && r.value <= 5)) return undefined;
  return {
    '@type': 'AggregateRating',
    ratingValue: Math.round(r.value * 10) / 10,
    ratingCount: r.count,
    bestRating: 5,
    worstRating: 1,
  };
}

/**
 * 应用的结构化数据。aggregateRating 默认不写：评分来自数据库里的真实评价（页面加载后由 island 显示），
 * 构建期拿不到，宁缺毋滥（站点原则：不伪造评分）；只有调用方传入构建期的真实汇总（条数 ≥ 1）才写。
 * offers 只在价格明确时写：免费 → price 0；付费且金额可解析 → 该金额；其余不写。
 */
export function softwareApp(a: {
  name: string;
  description: string;
  path: string;
  category: string;
  version?: string;
  image?: string;
  os?: string;
  /** schema.org applicationCategory（如 MultimediaApplication） */
  applicationCategory?: string;
  screenshots?: string[];
  price?: { model: string; amount?: string };
  rating?: RatingSummary;
  datePublished?: string;
  dateModified?: string;
  license?: string;
  codeRepository?: string;
  /** 第三方开发者（不写 = 本站作者） */
  developer?: { name: string; url?: string };
  /** 页面语言（英文版传 'en'；不写 = 不输出） */
  inLanguage?: string;
}): Json {
  return {
    '@type': 'SoftwareApplication',
    ...(a.inLanguage ? { inLanguage: a.inLanguage } : {}),
    name: a.name,
    description: a.description,
    url: abs(a.path),
    applicationCategory: a.applicationCategory ?? a.category,
    ...(a.applicationCategory ? { applicationSubCategory: a.category } : {}),
    ...(a.version ? { softwareVersion: a.version } : {}),
    operatingSystem: a.os ?? 'Web',
    ...(a.image ? { image: abs(a.image) } : {}),
    ...(a.screenshots?.length ? { screenshot: a.screenshots.map((s) => abs(s)) } : {}),
    ...(offerFrom(a.price) ? { offers: offerFrom(a.price) } : {}),
    ...(aggregateRating(a.rating) ? { aggregateRating: aggregateRating(a.rating) } : {}),
    ...(a.datePublished ? { datePublished: a.datePublished } : {}),
    ...(a.dateModified ? { dateModified: a.dateModified } : {}),
    ...(a.license && /^https:/.test(a.license) ? { license: a.license } : {}),
    ...(a.codeRepository ? { sameAs: a.codeRepository } : {}),
    author: a.developer
      ? {
          '@type': 'Organization',
          name: a.developer.name,
          ...(a.developer.url ? { url: a.developer.url } : {}),
        }
      : AUTHOR_INLINE,
  };
}

/**
 * 视频详情页：VideoObject。只写核实过的字段——时长 / 发布时间查不到就不写；不写播放量（interactionStatistic）。
 * 章节（作者在简介里给出的时间点）写成 Clip，指向原平台的对应时间点。
 */
export function videoObject(v: {
  name: string;
  description: string;
  path: string;
  thumbnails: string[];
  embedUrl: string;
  uploadDate?: string;
  /** ISO 8601，如 PT12M4S */
  duration?: string;
  inLanguage?: string;
  author: { name: string; url: string };
  clips?: { name: string; startOffset: number; endOffset?: number; url: string }[];
}): Json {
  return {
    '@type': 'VideoObject',
    name: v.name,
    description: v.description,
    url: abs(v.path),
    thumbnailUrl: v.thumbnails.map((t) => abs(t)),
    embedUrl: v.embedUrl,
    ...(v.uploadDate ? { uploadDate: v.uploadDate } : {}),
    ...(v.duration ? { duration: v.duration } : {}),
    ...(v.inLanguage ? { inLanguage: v.inLanguage } : {}),
    author: { '@type': 'Organization', name: v.author.name, url: v.author.url },
    ...(v.clips?.length
      ? {
          hasPart: v.clips.map((c) => ({
            '@type': 'Clip',
            name: c.name,
            startOffset: c.startOffset,
            ...(c.endOffset != null ? { endOffset: c.endOffset } : {}),
            url: c.url,
          })),
        }
      : {}),
  };
}

/** 列表页（/ai/ 等）：ItemList，每项指向详情页 */
export const itemList = (name: string, path: string, items: { name: string; path: string }[]): Json => ({
  '@type': 'ItemList',
  name,
  url: abs(path),
  numberOfItems: items.length,
  itemListElement: items.map((it, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: it.name,
    url: abs(it.path),
  })),
});

export function videoGame(g: {
  name: string;
  description: string;
  path: string;
  genre: string;
  version: string;
  image: string;
  date: string;
  inLanguage?: string;
}): Json {
  return {
    '@type': 'VideoGame',
    name: g.name,
    description: g.description,
    url: abs(g.path),
    genre: g.genre,
    version: g.version,
    image: abs(g.image),
    dateModified: iso(g.date),
    inLanguage: g.inLanguage ?? SITE.lang,
    gamePlatform: 'Web browser',
    operatingSystem: 'Web',
    applicationCategory: 'GameApplication',
    playMode: 'SinglePlayer',
    author: AUTHOR_INLINE,
  };
}

export function creativeWork(w: {
  name: string;
  description: string;
  path: string;
  genre: string;
  image: string;
  date: string;
}): Json {
  return {
    '@type': 'CreativeWork',
    name: w.name,
    description: w.description,
    url: abs(w.path),
    genre: w.genre,
    image: abs(w.image),
    dateCreated: w.date,
    author: AUTHOR_REF,
  };
}

export function forumPosting(t: {
  title: string;
  body: string;
  path: string;
  date: string;
  author: string;
  replies: { body: string; date: string; author: string }[];
}): Json {
  return {
    '@type': 'DiscussionForumPosting',
    headline: t.title,
    text: t.body,
    url: abs(t.path),
    datePublished: iso(t.date),
    author: { '@type': 'Person', name: t.author },
    commentCount: t.replies.length,
    comment: t.replies.map((r) => ({
      '@type': 'Comment',
      text: r.body,
      datePublished: iso(r.date),
      author: { '@type': 'Person', name: r.author },
    })),
  };
}

export const graph = (...nodes: Json[]) => ({ '@context': 'https://schema.org', '@graph': nodes });

/** 安全序列化：防止 </script> 注入 */
export const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
