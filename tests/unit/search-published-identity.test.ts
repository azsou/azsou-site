import { describe, expect, it } from 'vitest';
import { mergeHits, type SearchHit, type SearchItem } from '@/lib/search';

const route = (slug: string) => `/articles/published/?slug=${slug}`;
const article = (slug: string): SearchItem => ({
  type: 'article',
  title: `合成文章 ${slug}`,
  url: route(slug),
});
const preview = (url: string, text: string): SearchHit => ({
  type: 'article',
  title: '合成文章',
  url,
  sub: '',
  excerpt: [{ text, mark: false }],
});

// Synthetic inputs only. This tests identity after source validation, not publication, indexing or access.
describe('SB11: 保留公开文章的独立搜索身份', () => {
  it('两个不同 slug 都出现；不会把后一篇的摘要补给前一篇', () => {
    const first = article('sb11-alpha');
    const second = preview(route('sb11-beta'), '仅属于 beta 的片段');
    const hits = mergeHits([first], '合成文章', [second]);
    expect(hits.map((h) => h.url)).toEqual([first.url, second.url]);
    expect(hits[0].excerpt).toBeUndefined();
    expect(hits[1].excerpt).toEqual(second.excerpt);
  });

  it('同一 slug 的两条当前结果忽略跟踪参数和片段，仍只保留一次', () => {
    const first = article('sb11-alpha');
    const same = preview('/articles/published/?src=contract&slug=sb11-alpha#top', '同一公开版的片段');
    const hits = mergeHits([first], '合成文章', [same]);
    expect(hits.map((h) => h.url)).toEqual([first.url]);
    expect(hits[0].excerpt).toEqual(same.excerpt);
  });

  it('旧 Git 文章仍按原路径去重，不把跟踪参数变成第二篇', () => {
    const old: SearchItem = { type: 'article', title: '合成文章', url: '/articles/sb11-legacy/' };
    const duplicate = preview('/articles/sb11-legacy/index.html?src=contract#top', '旧索引片段');
    const hits = mergeHits([old], '合成文章', [duplicate]);
    expect(hits.map((h) => h.url)).toEqual([old.url]);
  });
});
