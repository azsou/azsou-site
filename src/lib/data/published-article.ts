import { DataUnavailableError } from './types';

// 订阅与列表所需的公开元数据。五项都可为 null；旧形状（缺这五列）一律按坏回执拒绝，
// 所以上线顺序必须是先升级数据库函数、再部署站点。
export interface PublishedArticleMeta {
  date: string | null;
  author: string | null;
  category: string | null;
  badge: string | null;
  summary: string | null;
}

export interface PublishedArticle extends PublishedArticleMeta {
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

// 发布门禁接受 YYYY-MM 或 YYYY-MM-DD；这里只放行真实存在的日历日期。
function validPublicDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (match[3] === undefined) return true;
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function readMeta(record: Record<string, unknown>, status: number): PublishedArticleMeta {
  const { date, author, category, badge, summary } = record;
  if (date !== null && (typeof date !== 'string' || !validPublicDate(date))) throw malformed(status);
  // 发布门禁要求作者、分类非空；摘要缺失用 null，不接受空串。徽标允许空串。
  for (const value of [author, category, summary]) {
    if (value !== null && (typeof value !== 'string' || !value.trim())) throw malformed(status);
  }
  if (badge !== null && typeof badge !== 'string') throw malformed(status);
  return {
    date: date as string | null,
    author: author as string | null,
    category: category as string | null,
    badge: badge as string | null,
    summary: summary as string | null,
  };
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
    Object.keys(record).sort().join(',') !==
      'author,badge,body_text,category,date,revision,slug,summary,title' ||
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
  const meta = readMeta(record, reply.status);
  return { slug, revision: record.revision, title: record.title, ...meta, bodyText: record.body_text };
}

export interface PublishedArticleSummary extends PublishedArticleMeta {
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
      Object.keys(record).sort().join(',') !== 'author,badge,category,date,revision,slug,summary,title' ||
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
    const meta = readMeta(record, reply.status);
    articles.push({ slug: record.slug, revision: record.revision, title: record.title, ...meta });
    previousSlug = record.slug;
  }
  return articles;
}
