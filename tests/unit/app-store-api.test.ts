/** 应用商店数据接口（src/lib/data/app-store.ts）：请求形状、错误映射、前端校验——用假 fetch，不连数据库 */
import { describe, expect, it, vi } from 'vitest';
import { checkReview, createAppStoreApi } from '@/lib/data/app-store';
import { DataUnavailableError, NotSignedInError, RateLimitedError, ValidationError } from '@/lib/data/types';

const BASE = 'https://db.example.com';
function setup(
  responses: Record<string, { status?: number; body: unknown }>,
  token: string | null = 'jwt-1',
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key] : { status: 404, body: { code: 'PGRST205' } };
    return new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const api = createAppStoreApi({
    url: BASE,
    key: 'anon-key',
    token: async () => token,
    fetch: fetch as never,
  });
  return { api, calls };
}

describe('createAppStoreApi', () => {
  it('stats() 读取下载计数与评分视图并合并', async () => {
    const { api, calls } = setup({
      'app_download_counts?': {
        body: [
          { app: 'a', downloads: 2 },
          { app: 'a', downloads: 3 },
        ],
      },
      'app_review_stats?': { body: [{ app: 'a', reviews: 1, average: 5 }] },
    });
    expect(await api.stats(['a', 'Bad Slug'])).toEqual({ a: { downloads: 5, reviews: 1, average: 5 } });
    expect(calls[0].url).toContain('app=in.(a)');
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('anon-key');
  });
  it('appStats() 没有评价时给出 0 与 null，不编造', async () => {
    const { api } = setup({ 'app_download_counts?': { body: [] }, 'app_review_stats?': { body: [] } });
    expect(await api.appStats('fablemotion')).toEqual({
      downloads: {},
      reviews: { reviews: 0, average: null, distribution: [0, 0, 0, 0, 0] },
    });
  });
  it('countDownload() 调 RPC（keepalive），返回累计数', async () => {
    const { api, calls } = setup({ 'rpc/app_count_download': { body: 7 } });
    expect(await api.countDownload('fablemotion', 'web')).toBe(7);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ p_app: 'fablemotion', p_platform: 'web' });
    expect(calls[0].init.keepalive).toBe(true);
  });
  it('旧库（没执行 0012）→ DataUnavailableError', async () => {
    const { api } = setup({ 'rpc/app_count_download': { status: 404, body: { code: 'PGRST202' } } });
    await expect(api.countDownload('a', 'web')).rejects.toBeInstanceOf(DataUnavailableError);
  });
  it('网络错误 → DataUnavailableError', async () => {
    const api = createAppStoreApi({
      url: BASE,
      key: 'k',
      token: async () => null,
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as never,
    });
    await expect(api.stats()).rejects.toBeInstanceOf(DataUnavailableError);
  });
  it('listReviews() 多取一条判断是否还有下一页，只取已发布', async () => {
    const row = (i: number) => ({
      id: `00000000-0000-4000-a000-00000000000${i}`,
      app: 'a',
      author: 'u',
      rating: 4,
      title: '',
      body: 'b',
      version: '',
      published: true,
      created_at: '2026-10-01T00:00:00Z',
      edited_at: null,
      profiles: { display_name: '小明' },
    });
    const { api, calls } = setup({ 'app_reviews?': { body: [row(1), row(2), row(3)] } });
    const r = await api.listReviews('a', { limit: 2 });
    expect(r.more).toBe(true);
    expect(r.items.map((x) => x.author.name)).toEqual(['小明', '小明']);
    expect(calls[0].url).toContain('published=eq.true');
    expect(calls[0].url).toContain('limit=3');
  });
  it('写评价需要登录', async () => {
    const { api } = setup({}, null);
    await expect(api.createReview('a', { rating: 5 })).rejects.toBeInstanceOf(NotSignedInError);
  });
  it('重复评价（23505）与限流（PT429）映射成中文错误', async () => {
    const dup = setup({ 'app_reviews?': { status: 409, body: { code: '23505', message: 'duplicate key' } } });
    await expect(dup.api.createReview('a', { rating: 5 })).rejects.toBeInstanceOf(ValidationError);
    const rl = setup({
      'app_reviews?': { status: 429, body: { code: 'PT429', hint: '操作太频繁，请稍后再试。' } },
    });
    await expect(rl.api.createReview('a', { rating: 5 })).rejects.toBeInstanceOf(RateLimitedError);
  });
  it('删除返回 0 行 = 没有权限', async () => {
    const { api } = setup({ 'app_reviews?': { body: [] } });
    await expect(api.deleteReview('00000000-0000-4000-a000-000000000001')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(api.deleteReview('not-a-uuid')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('checkReview', () => {
  it.each([
    [{ rating: 0 }, '请选择 1–5 星'],
    [{ rating: 6 }, '请选择 1–5 星'],
    [{ rating: 4.5 }, '请选择 1–5 星'],
    [{ rating: 5, title: 'x'.repeat(61) }, '标题最多 60 个字'],
    [{ rating: 5, body: 'x'.repeat(1001) }, '评价最多 1000 个字'],
  ])('%j → %s', (input, msg) => expect(checkReview(input)).toBe(msg));
  it('只打星也可以', () => expect(checkReview({ rating: 3 })).toBeNull());
});
