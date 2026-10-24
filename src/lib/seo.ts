import { SITE } from './site';
import { toDate } from './dates';

export const abs = (path: string) => new URL(path, SITE.url).toString();

type Json = Record<string, unknown>;

export interface Crumb {
  name: string;
  path: string;
}

const AUTHOR_REF = { '@id': `${SITE.url}/#author` };
const iso = (d: string) => toDate(d).toISOString();

export const person = (): Json => ({
  '@type': 'Person',
  '@id': `${SITE.url}/#author`,
  name: SITE.author.name,
  url: SITE.author.url,
});

export const website = (): Json => ({
  '@type': 'WebSite',
  '@id': `${SITE.url}/#website`,
  name: SITE.name,
  url: `${SITE.url}/`,
  inLanguage: SITE.lang,
  description: SITE.description,
  author: AUTHOR_REF,
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${SITE.url}/search/?q={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
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
    author: AUTHOR_REF,
    publisher: AUTHOR_REF,
  };
}

/**
 * 应用的结构化数据。aggregateRating 不写进静态 HTML：评分来自数据库里的真实评价（页面加载后由 island 显示），
 * 构建期拿不到，宁缺毋滥（站点原则：不伪造评分）。只在价格明确为免费时写 offers（price 0）。
 */
export function softwareApp(a: {
  name: string;
  description: string;
  path: string;
  category: string;
  version: string;
  image?: string;
  os?: string;
  /** schema.org applicationCategory（如 MultimediaApplication） */
  applicationCategory?: string;
  screenshots?: string[];
  free?: boolean;
  datePublished?: string;
  dateModified?: string;
  license?: string;
  codeRepository?: string;
  /** 第三方开发者（不写 = 本站作者） */
  developer?: { name: string; url?: string };
}): Json {
  return {
    '@type': 'SoftwareApplication',
    name: a.name,
    description: a.description,
    url: abs(a.path),
    applicationCategory: a.applicationCategory ?? a.category,
    ...(a.applicationCategory ? { applicationSubCategory: a.category } : {}),
    softwareVersion: a.version,
    operatingSystem: a.os ?? 'Web',
    ...(a.image ? { image: abs(a.image) } : {}),
    ...(a.screenshots?.length ? { screenshot: a.screenshots.map((s) => abs(s)) } : {}),
    ...(a.free ? { offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' } } : {}),
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
      : AUTHOR_REF,
  };
}

export function videoGame(g: {
  name: string;
  description: string;
  path: string;
  genre: string;
  version: string;
  image: string;
  date: string;
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
    gamePlatform: 'Web browser',
    playMode: 'SinglePlayer',
    author: AUTHOR_REF,
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
