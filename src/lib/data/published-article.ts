import { DataUnavailableError } from './types';

export interface PublishedArticle {
  slug: string;
  revision: number;
  title: string;
  bodyText: string;
}

export function validPublicArticleSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function malformed(status: number) {
  return new DataUnavailableError('文章读取回执不完整', { kind: 'bad-response', status });
}

// Anonymous projection only. An empty array means absent; a read failure never means unpublished.
export async function readPublishedArticle(
  config: { url: string; key: string },
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedArticle | null> {
  if (!validPublicArticleSlug(slug)) throw new TypeError('invalid article slug');
  const reply = await fetchImpl(`${config.url}/rest/v1/rpc/az_cms_read_published_article`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { apikey: config.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ p_slug: slug }),
  });
  if (!reply.ok) {
    const kind = reply.status >= 500 ? 'server' : 'bad-response';
    throw new DataUnavailableError('文章读取失败', { kind, status: reply.status });
  }
  let rows: unknown;
  try {
    rows = await reply.json();
  } catch {
    throw malformed(reply.status);
  }
  if (Array.isArray(rows) && rows.length === 0) return null;
  const row: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw malformed(reply.status);
  const record = row as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'body_text,revision,slug,title' ||
    record.slug !== slug ||
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    typeof record.body_text !== 'string'
  ) {
    throw malformed(reply.status);
  }
  return { slug, revision: record.revision, title: record.title, bodyText: record.body_text };
}

export interface PublishedArticleSummary {
  slug: string;
  revision: number;
  title: string;
}

// Anonymous catalog projection only. A read failure never means an empty catalog.
export async function listPublishedArticles(
  config: { url: string; key: string },
  afterSlug: string | null,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedArticleSummary[]> {
  if (afterSlug !== null && (typeof afterSlug !== 'string' || !validPublicArticleSlug(afterSlug))) {
    throw new TypeError('invalid article cursor');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('invalid article limit');
  }

  const reply = await fetchImpl(`${config.url}/rest/v1/rpc/az_cms_list_published_articles`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: { apikey: config.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ p_after_slug: afterSlug, p_limit: limit }),
  });
  if (!reply.ok || reply.status !== 200) {
    const kind = reply.status >= 500 ? 'server' : 'bad-response';
    throw new DataUnavailableError('文章列表读取失败', { kind, status: reply.status });
  }

  let rows: unknown;
  try {
    rows = await reply.json();
  } catch {
    throw malformed(reply.status);
  }
  if (!Array.isArray(rows) || rows.length > limit) throw malformed(reply.status);

  const articles: PublishedArticleSummary[] = [];
  let previousSlug = afterSlug;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw malformed(reply.status);
    const record = row as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'revision,slug,title' ||
      typeof record.slug !== 'string' ||
      !validPublicArticleSlug(record.slug) ||
      (previousSlug !== null && record.slug <= previousSlug) ||
      typeof record.revision !== 'number' ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      typeof record.title !== 'string' ||
      !record.title.trim()
    ) {
      throw malformed(reply.status);
    }
    articles.push({ slug: record.slug, revision: record.revision, title: record.title });
    previousSlug = record.slug;
  }
  return articles;
}
