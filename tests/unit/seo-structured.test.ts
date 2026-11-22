/**
 * T6.10 结构化数据的纯函数：价格 → Offer、真实评价汇总 → AggregateRating（条数 ≥ 1 才写）、
 * Organization / Article 作者字段。构建产物里的逐页校验见 tests/built/structured-data.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateRating,
  article,
  offerFrom,
  organization,
  softwareApp,
  videoGame,
  website,
} from '@/lib/seo';

describe('offerFrom', () => {
  it('free → price 0', () => {
    expect(offerFrom({ model: 'free' })).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'CNY' });
  });
  it('paid with an explicit amount → that amount and currency', () => {
    expect(offerFrom({ model: 'paid', amount: '¥18' })).toMatchObject({ price: '18', priceCurrency: 'CNY' });
    expect(offerFrom({ model: 'paid', amount: '18 元' })).toMatchObject({
      price: '18',
      priceCurrency: 'CNY',
    });
    expect(offerFrom({ model: 'paid', amount: '$4.99' })).toMatchObject({
      price: '4.99',
      priceCurrency: 'USD',
    });
  });
  it('unknown or non-numeric prices → no offer (never guessed)', () => {
    for (const p of [
      { model: 'tbd' },
      { model: 'freemium' },
      { model: 'subscription' },
      { model: 'paid' },
      { model: 'paid', amount: '按量计费' },
      { model: 'paid', amount: '18' }, // 没写币种
      { model: 'paid', amount: '¥18 起' },
    ])
      expect(offerFrom(p)).toBeUndefined();
    expect(offerFrom(undefined)).toBeUndefined();
  });
});

describe('aggregateRating', () => {
  it('only with at least one real review', () => {
    expect(aggregateRating(undefined)).toBeUndefined();
    expect(aggregateRating({ value: 4.5, count: 0 })).toBeUndefined();
    expect(aggregateRating({ value: 0, count: 3 })).toBeUndefined();
    expect(aggregateRating({ value: 6, count: 3 })).toBeUndefined();
    expect(aggregateRating({ value: 4.46, count: 3 })).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      ratingCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
  });
  it('softwareApp omits rating / offers unless given real data', () => {
    const base = { name: 'X', description: 'd', path: '/apps/x/', category: '工具' };
    const bare = softwareApp(base);
    expect(bare).not.toHaveProperty('aggregateRating');
    expect(bare).not.toHaveProperty('offers');
    expect(bare.operatingSystem).toBe('Web');
    expect(softwareApp({ ...base, rating: { value: 4, count: 0 } })).not.toHaveProperty('aggregateRating');
    const rated = softwareApp({ ...base, price: { model: 'free' }, rating: { value: 4, count: 2 } });
    expect(rated.offers).toMatchObject({ price: '0' });
    expect(rated.aggregateRating).toMatchObject({ ratingCount: 2 });
  });
});

describe('site entities', () => {
  it('Organization has a logo; WebSite has a SearchAction and a publisher', () => {
    const o = organization() as { logo: { url: string }; '@id': string };
    expect(o.logo.url).toBe('https://azsou.com/icons/icon-512.png');
    const w = website() as {
      publisher: { '@id': string };
      potentialAction: { target: { urlTemplate: string }; 'query-input': string };
    };
    expect(w.publisher['@id']).toBe(o['@id']);
    expect(w.potentialAction.target.urlTemplate).toContain('{search_term_string}');
    expect(w.potentialAction['query-input']).toBe('required name=search_term_string');
  });
  it('articles carry an inline author name and the Organization as publisher', () => {
    const a = article({
      title: 't',
      description: 'd',
      path: '/articles/a/',
      date: '2026-07-19',
      modified: '2026-07-20',
      image: '/og/a.png',
      section: 's',
      keywords: [],
    }) as { author: { name: string; '@type': string }; publisher: { '@id': string } };
    expect(a.author).toMatchObject({ '@type': 'Person', name: 'Randy Hopkins' });
    expect(a.publisher['@id']).toBe('https://azsou.com/#org');
  });
  it('VideoGame is also a SoftwareApplication (OS + category), with no rating', () => {
    const g = videoGame({
      name: 'G',
      description: 'd',
      path: '/games/g/',
      genre: 'x',
      version: '0.1',
      image: '/og/g.png',
      date: '2026-07',
    });
    expect(g).toMatchObject({ operatingSystem: 'Web', applicationCategory: 'GameApplication' });
    expect(g).not.toHaveProperty('aggregateRating');
  });
});
