import { describe, expect, it } from 'vitest';
import { CANARY_SLUG, readPublishedCanary } from '@/lib/data/article-canary';
import { DataUnavailableError } from '@/lib/data/types';

const config = { url: 'https://example-test.supabase.co', key: 'public-key' };

function reply(body: unknown, ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('访客读取验收文章', () => {
  it('只读一个公开函数：不带登录、不缓存、只传固定标识', async () => {
    const { fetchImpl, calls } = reply([
      { slug: CANARY_SLUG, revision: 1, title: '标题', body_text: '正文' },
    ]);
    await expect(readPublishedCanary(config, fetchImpl)).resolves.toEqual({
      slug: CANARY_SLUG,
      revision: 1,
      title: '标题',
      bodyText: '正文',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://example-test.supabase.co/rest/v1/rpc/az_cms_read_published_article_canary',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_slug: CANARY_SLUG });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('public-key');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('没有已发布版本（含已下架）时返回 null', async () => {
    await expect(readPublishedCanary(config, reply([]).fetchImpl)).resolves.toBeNull();
  });

  it('网络失败、回执缺项、标识不符都拒绝，不显示半截内容', async () => {
    await expect(readPublishedCanary(config, reply([], false).fetchImpl)).rejects.toBeInstanceOf(
      DataUnavailableError,
    );
    const bad = [
      [{ slug: 'other-article', revision: 1, title: 'a', body_text: 'b' }],
      [{ slug: CANARY_SLUG, revision: 0, title: 'a', body_text: 'b' }],
      [{ slug: CANARY_SLUG, revision: 1, title: 1, body_text: 'b' }],
      [{ slug: CANARY_SLUG, revision: 1, title: 'a' }],
      [
        { slug: CANARY_SLUG, revision: 1, title: 'a', body_text: 'b' },
        { slug: CANARY_SLUG, revision: 1, title: 'a', body_text: 'b' },
      ],
      null,
      { slug: CANARY_SLUG },
    ];
    for (const data of bad) {
      await expect(
        readPublishedCanary(config, reply(data).fetchImpl),
        JSON.stringify(data),
      ).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });
});
