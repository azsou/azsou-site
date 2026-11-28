import { describe, expect, it } from 'vitest';
import { listPublishedArticles } from '@/lib/data/published-article';
import { DataUnavailableError } from '@/lib/data/types';

const config = { url: 'http://127.0.0.1:47311', key: 'sb10-fixture-only' };
// SB12：目录行固定带五项公开元数据（可为 null）；旧三列形状由 published-article-metadata.test.ts 负责拒绝。
const none = { date: null, author: null, category: null, badge: null, summary: null };

type FakeReply = { status?: number; ok?: boolean; body?: unknown; jsonError?: Error };

function fake(reply: FakeReply | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status ?? 200,
      ok: reply.ok ?? true,
      json: async () => {
        if (reply.jsonError) throw reply.jsonError;
        return reply.body;
      },
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('公开文章目录读取', () => {
  it('读取普通页和空页，只提交固定公开请求', async () => {
    const page = fake({
      body: [
        { slug: 'alpha', revision: 2, title: '甲', ...none },
        { slug: 'beta-two', revision: 1, title: '乙', ...none },
      ],
    });
    await expect(listPublishedArticles(config, null, 2, page.fetchImpl)).resolves.toEqual([
      { slug: 'alpha', revision: 2, title: '甲', ...none },
      { slug: 'beta-two', revision: 1, title: '乙', ...none },
    ]);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]!.url).toBe('http://127.0.0.1:47311/rest/v1/rpc/az_cms_list_published_articles');
    expect(page.calls[0]!.init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(page.calls[0]!.init.headers).toEqual({
      apikey: config.key,
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(JSON.parse(String(page.calls[0]!.init.body))).toEqual({
      p_after_slug: null,
      p_limit: 2,
    });
    const empty = fake({ body: [] });
    await expect(listPublishedArticles(config, 'beta-two', 1, empty.fetchImpl)).resolves.toEqual([]);
  });

  it('网络、HTTP 错误和坏回执都拒绝，不变成空页', async () => {
    await expect(
      listPublishedArticles(config, null, 5, fake(new Error('network')).fetchImpl),
    ).rejects.toThrow('network');
    await expect(
      listPublishedArticles(config, null, 5, fake({ status: 206, body: [] }).fetchImpl),
    ).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(
      listPublishedArticles(config, null, 5, fake({ jsonError: new Error('invalid JSON') }).fetchImpl),
    ).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(
      listPublishedArticles(config, null, 5, fake({ status: 503, ok: false, body: [] }).fetchImpl),
    ).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(
      listPublishedArticles(
        config,
        null,
        5,
        fake({ body: [{ slug: 'alpha', revision: 1, title: '', ...none }] }).fetchImpl,
      ),
    ).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(
      listPublishedArticles(
        config,
        null,
        5,
        fake({ body: [{ slug: 'alpha', revision: 1, title: '甲', ...none, private_field: 'no' }] }).fetchImpl,
      ),
    ).rejects.toBeInstanceOf(DataUnavailableError);
  });

  it('输入在请求前拒绝，并拒绝重复或非递增游标页', async () => {
    const invalid = fake({ body: [] });
    for (const slug of ['', 'Upper', 'a_b', 'a-', 'x'.repeat(81)]) {
      await expect(listPublishedArticles(config, slug, 1, invalid.fetchImpl)).rejects.toThrow(
        'invalid article cursor',
      );
    }
    for (const limit of [0, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(listPublishedArticles(config, null, limit, invalid.fetchImpl)).rejects.toThrow(
        'invalid article limit',
      );
    }
    expect(invalid.calls).toHaveLength(0);

    for (const body of [
      [
        { slug: 'beta', revision: 1, title: '乙', ...none },
        { slug: 'beta', revision: 2, title: '重复', ...none },
      ],
      [
        { slug: 'beta', revision: 1, title: '乙', ...none },
        { slug: 'alpha', revision: 1, title: '甲', ...none },
      ],
    ]) {
      await expect(
        listPublishedArticles(config, 'alpha', 2, fake({ body }).fetchImpl),
      ).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });
});
