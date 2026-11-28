/**
 * 访客侧读取：只用来验收"站长发布后访客真的能看到、下架后真的看不到"。
 * 只读 az_cms_read_published_article_canary 一个公开函数：不带登录、不缓存、不回退到草稿。
 * 返回的 bodyText 是不可信的纯文本，调用方只能用 textContent 显示。
 */
import { DataUnavailableError } from './types';

export const CANARY_SLUG = 'sb09-release-check-8ce16f5f';

export interface PublishedCanary {
  slug: string;
  revision: number;
  title: string;
  bodyText: string;
}

export async function readPublishedCanary(
  config: { url: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedCanary | null> {
  const response = await fetchImpl(`${config.url}/rest/v1/rpc/az_cms_read_published_article_canary`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { apikey: config.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ p_slug: CANARY_SLUG }),
  });
  if (!response.ok) throw new DataUnavailableError('访客读取失败', { kind: 'bad-response' });
  const data: unknown = await response.json();
  if (Array.isArray(data) && data.length === 0) return null;
  const row = Array.isArray(data) && data.length === 1 ? (data[0] as Record<string, unknown> | null) : null;
  if (
    !row ||
    typeof row !== 'object' ||
    row.slug !== CANARY_SLUG ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.title !== 'string' ||
    typeof row.body_text !== 'string'
  ) {
    throw new DataUnavailableError('访客读取回执不完整', { kind: 'bad-response' });
  }
  return { slug: row.slug, revision: row.revision, title: row.title, bodyText: row.body_text };
}
