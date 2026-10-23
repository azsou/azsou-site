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

/** 不写 aggregateRating / offers：站点原则是不伪造评分 */
export function softwareApp(a: {
  name: string;
  description: string;
  path: string;
  category: string;
  version: string;
  image?: string;
  os?: string;
}): Json {
  return {
    '@type': 'SoftwareApplication',
    name: a.name,
    description: a.description,
    url: abs(a.path),
    applicationCategory: a.category,
    softwareVersion: a.version,
    operatingSystem: a.os ?? 'Web',
    ...(a.image ? { image: abs(a.image) } : {}),
    author: AUTHOR_REF,
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
