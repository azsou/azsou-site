import { describe, expect, it } from 'vitest';
import { listPublishedArticles, readPublishedArticle } from '@/lib/data/published-article';
import { DataUnavailableError } from '@/lib/data/types';

// SB12 候选先红测试：公开目录与公开详情带上订阅所需的五个公开元数据。
// 字段含义（date 指发布日还是更新日、摘要是否必填、作者/分类/徽标文案）尚待站长决定：
// 这里只固定形状与失败关闭，五项都允许为 null，不预设任何一项必填。
const config = { url: 'http://127.0.0.1:47311', key: 'sb12-fixture-only' };

type FakeReply = { status?: number; ok?: boolean; body?: unknown };

function fake(reply: FakeReply) {
  const fetchImpl = (async () =>
    ({
      status: reply.status ?? 200,
      ok: reply.ok ?? true,
      json: async () => reply.body,
    }) as Response) as unknown as typeof fetch;
  return { fetchImpl };
}

const full = {
  date: '2026-11-20',
  author: 'AZ Studio',
  category: '产品',
  badge: '新',
  summary: '一段公开摘要。',
};
const empty = { date: null, author: null, category: null, badge: null, summary: null };

describe('公开目录带公开元数据', () => {
  it('目录行带五项元数据时原样返回，允许全部为 null', async () => {
    const page = fake({
      body: [
        { slug: 'alpha', revision: 2, title: '甲', ...full },
        { slug: 'beta-two', revision: 1, title: '乙', ...empty },
      ],
    });
    await expect(listPublishedArticles(config, null, 2, page.fetchImpl)).resolves.toEqual([
      { slug: 'alpha', revision: 2, title: '甲', ...full },
      { slug: 'beta-two', revision: 1, title: '乙', ...empty },
    ]);
  });

  it('旧三列回执、缺项、多余私有列和坏类型都按坏回执拒绝', async () => {
    const bad: Record<string, unknown>[] = [
      { slug: 'alpha', revision: 1, title: '甲' },
      { slug: 'alpha', revision: 1, title: '甲', ...full, author: undefined },
      { slug: 'alpha', revision: 1, title: '甲', ...full, private_field: 'no' },
      { slug: 'alpha', revision: 1, title: '甲', ...full, date: 20261120 },
      { slug: 'alpha', revision: 1, title: '甲', ...full, date: '2026-13-40' },
      { slug: 'alpha', revision: 1, title: '甲', ...full, author: '' },
      { slug: 'alpha', revision: 1, title: '甲', ...full, summary: 7 },
    ];
    for (const row of bad) {
      await expect(
        listPublishedArticles(config, null, 5, fake({ body: [row] }).fetchImpl),
      ).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });
});

describe('公开详情带公开元数据', () => {
  it('详情带五项元数据时返回，正文仍只作文本', async () => {
    const row = { slug: 'alpha', revision: 3, title: '甲', ...full, body_text: '<b>正文</b>' };
    await expect(readPublishedArticle(config, 'alpha', fake({ body: [row] }).fetchImpl)).resolves.toEqual({
      slug: 'alpha',
      revision: 3,
      title: '甲',
      ...full,
      bodyText: '<b>正文</b>',
    });
    const none = { slug: 'alpha', revision: 3, title: '甲', ...empty, body_text: '' };
    await expect(readPublishedArticle(config, 'alpha', fake({ body: [none] }).fetchImpl)).resolves.toEqual({
      slug: 'alpha',
      revision: 3,
      title: '甲',
      ...empty,
      bodyText: '',
    });
  });

  it('旧四列回执、多余私有列和坏类型都按坏回执拒绝', async () => {
    const base = { slug: 'alpha', revision: 3, title: '甲', body_text: 'x' };
    const bad: Record<string, unknown>[] = [
      base,
      { ...base, ...full, private_field: 'no' },
      { ...base, ...full, date: '2026-02-30' },
      { ...base, ...full, badge: false },
      { ...base, ...full, category: '' },
    ];
    for (const row of bad) {
      await expect(
        readPublishedArticle(config, 'alpha', fake({ body: [row] }).fetchImpl),
      ).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });
});
