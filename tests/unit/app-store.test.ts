/** 应用商店（P6）纯函数：平台识别、筛选 / 排序 / 分页、查询串、统计合并与格式化 */
import { describe, expect, it } from 'vitest';
import {
  detectOs,
  filterApps,
  formatCount,
  formatRating,
  hostOf,
  isSha256,
  mergeStats,
  pageUrl,
  paginate,
  parseQuery,
  pickPlatform,
  sortApps,
  toQueryString,
  type CatalogItem,
} from '@/lib/app-store';

const UA = {
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
};

describe('detectOs', () => {
  it.each([
    ['win', 'windows'],
    ['mac', 'macos'],
    ['iphone', 'ios'],
    ['android', 'android'],
    ['linux', 'linux'],
  ] as const)('%s → %s', (k, os) => expect(detectOs({ userAgent: UA[k] })).toBe(os));
  it('iPadOS 报 Macintosh 但有多点触控 → ios', () =>
    expect(detectOs({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe('ios'));
  it('userAgentData.platform 优先补充', () =>
    expect(detectOs({ userAgent: '', platform: 'Windows' })).toBe('windows'));
  it('认不出返回 null', () => expect(detectOs({ userAgent: 'SomethingElse/1.0' })).toBeNull());
});

describe('pickPlatform', () => {
  const avail = [
    { os: 'windows' as const, url: 'https://x' },
    { os: 'web' as const, url: 'https://y' },
    { os: 'android' as const, url: null },
  ];
  it('同系统优先', () => expect(pickPlatform(avail, 'windows')).toBe('windows'));
  it('没有同系统时退到通用平台（网页版）', () => expect(pickPlatform(avail, 'macos')).toBe('web'));
  it('没有下载地址的平台不会被推荐', () => expect(pickPlatform(avail, 'android')).toBe('web'));
  it('移动端不推荐桌面专用的扩展 / 命令行', () =>
    expect(pickPlatform([{ os: 'browser-ext', url: 'https://x' }], 'ios')).toBeNull());
  it('全部没有地址 → null', () => expect(pickPlatform([{ os: 'web', url: null }], 'windows')).toBeNull());
});

const item = (slug: string, o: Partial<CatalogItem> = {}): CatalogItem => ({
  slug,
  title: slug,
  subtitle: '',
  icon: '/apps/icons/x.svg',
  iconAlt: '',
  category: 'creative',
  categoryLabel: '创作工具',
  tags: [],
  platforms: ['web'],
  price: 'free',
  priceLabel: '免费',
  version: '1',
  status: '',
  statusClass: 'active',
  featured: false,
  updated: '2026-07-01',
  order: 1,
  url: `/apps/${slug}/`,
  ...o,
});

describe('filter / sort / paginate', () => {
  const list = [
    item('a', { updated: '2026-07-01', order: 2, platforms: ['web', 'windows'] }),
    item('b', { updated: '2026-07-19', order: 3, category: 'ai', price: 'tbd' }),
    item('c', { updated: '', order: 1, platforms: ['cli'] }),
    item('d', { updated: '2026-07-01', order: 1, category: 'ai' }),
  ];
  it('按平台 / 分类 / 价格筛选（组合为「且」）', () => {
    expect(filterApps(list, { platform: 'windows' }).map((x) => x.slug)).toEqual(['a']);
    expect(filterApps(list, { category: 'ai' }).map((x) => x.slug)).toEqual(['b', 'd']);
    expect(filterApps(list, { category: 'ai', price: 'free' }).map((x) => x.slug)).toEqual(['d']);
    expect(filterApps(list, {}).length).toBe(4);
  });
  it('最新：日期新的在前，同日按 order，没有日期的排最后', () =>
    expect(sortApps(list, 'new').map((x) => x.slug)).toEqual(['b', 'd', 'a', 'c']));
  it('热门 = 真实下载数', () =>
    expect(
      sortApps(list, 'hot', {
        c: { downloads: 50, reviews: 0, average: null },
        a: { downloads: 3, reviews: 0, average: null },
      }).map((x) => x.slug),
    ).toEqual(['c', 'a', 'b', 'd']));
  it('评分：平均分高的在前，同分评价多的在前，没有评分的排后', () =>
    expect(
      sortApps(list, 'rating', {
        a: { downloads: 0, reviews: 2, average: 4.5 },
        c: { downloads: 0, reviews: 9, average: 4.5 },
        d: { downloads: 0, reviews: 1, average: 5 },
      }).map((x) => x.slug),
    ).toEqual(['d', 'c', 'a', 'b']));
  it('没有统计数据时 hot / rating 退回最新', () =>
    expect(sortApps(list, 'hot', null).map((x) => x.slug)).toEqual(['b', 'd', 'a', 'c']));
  it('分页：越界页码夹到范围内', () => {
    const many = Array.from({ length: 13 }, (_, i) => i);
    expect(paginate(many, 1, 6)).toMatchObject({ page: 1, pages: 3, total: 13, items: [0, 1, 2, 3, 4, 5] });
    expect(paginate(many, 3, 6).items).toEqual([12]);
    expect(paginate(many, 99, 6).page).toBe(3);
    expect(paginate([], 1, 6)).toMatchObject({ page: 1, pages: 1, total: 0 });
  });
  it('静态分页地址', () => {
    expect(pageUrl('/apps/', 1)).toBe('/apps/');
    expect(pageUrl('/apps/', 2)).toBe('/apps/page/2/');
    expect(pageUrl('/apps/category/ai/', 3)).toBe('/apps/category/ai/page/3/');
  });
});

describe('query string', () => {
  it('解析合法值，忽略非法值', () => {
    expect(parseQuery('?platform=web&category=ai&price=free&sort=hot&page=2')).toEqual({
      platform: 'web',
      category: 'ai',
      price: 'free',
      sort: 'hot',
      page: 2,
    });
    expect(parseQuery('?platform=symbian&category=<x>&sort=random&page=-1')).toEqual({
      platform: '',
      category: '',
      price: '',
      sort: 'new',
      page: 1,
    });
  });
  it('默认值不写进地址', () => {
    expect(toQueryString({ sort: 'new', page: 1 })).toBe('');
    expect(toQueryString({ platform: 'web', sort: 'rating', page: 2 })).toBe(
      '?platform=web&sort=rating&page=2',
    );
  });
  it('往返一致', () => {
    const q = { platform: 'cli', category: 'dev-tools', price: 'tbd', sort: 'hot', page: 3 } as const;
    expect(parseQuery(toQueryString(q))).toEqual(q);
  });
});

describe('stats & format', () => {
  it('合并下载（多平台相加）与评分', () =>
    expect(
      mergeStats(
        [
          { app: 'a', downloads: '3' },
          { app: 'a', downloads: 2 },
          { app: 'b', downloads: 1 },
        ],
        [{ app: 'a', reviews: 2, average: '4.50' }],
      ),
    ).toEqual({
      a: { downloads: 5, reviews: 2, average: 4.5 },
      b: { downloads: 1, reviews: 0, average: null },
    }));
  it('数字格式', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(12345)).toBe('1.2 万');
    expect(formatCount(120000)).toBe('12 万');
    expect(formatCount(-5)).toBe('0');
    expect(formatRating(4.25)).toBe('4.3');
    expect(formatRating(5)).toBe('5.0');
  });
  it('sha256 / host', () => {
    expect(isSha256('a'.repeat(64))).toBe(true);
    expect(isSha256('a'.repeat(63))).toBe(false);
    expect(hostOf('https://github.com/x/y/releases')).toBe('github.com');
    expect(hostOf('not a url')).toBe('');
  });
});
