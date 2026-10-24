import { describe, expect, it } from 'vitest';
import { compareDesc, formatDate, monthKey, toDate } from '@/lib/dates';
import { url, relatedUrl, ogArt } from '@/lib/routes';
import { article, breadcrumbs, jsonLd, softwareApp } from '@/lib/seo';
import { TAGS, tagName } from '@/lib/tags';
import { initials, shortDate } from '@/scripts/render';

describe('dates', () => {
  it('parses dates in Asia/Shanghai', () => {
    expect(toDate('2026-07-19').toISOString()).toBe('2026-07-19T00:00:00.000Z');
    expect(toDate('2026-06').toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
  it('formats and groups', () => {
    expect(formatDate('2026-07-19')).toBe('2026 年 7 月 19 日');
    expect(formatDate('2026-06')).toBe('2026 年 6 月');
    expect(monthKey('2026-07-19')).toBe('2026-07');
    expect(['2026-07-17', '2026-07-25', '2026-07-19'].sort(compareDesc)).toEqual([
      '2026-07-25',
      '2026-07-19',
      '2026-07-17',
    ]);
  });
  it('shows database timestamps on Beijing calendar days', () => {
    expect(shortDate('2026-07-27T20:19:00Z')).toBe('2026-07-28');
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
  it('builds avatar initials', () => {
    expect(initials('Randy Hopkins')).toBe('RH');
    expect(initials('测试用户')).toBe('测试');
    expect(initials('  ')).toBe('?');
  });
});

describe('routes', () => {
  it('always ends page URLs with a slash', () => {
    for (const u of [
      url.apps(),
      url.app('x'),
      url.game('x'),
      url.article('x'),
      url.work('x'),
      url.tag('x'),
      url.forum(),
      url.forumCategory('tech'),
    ]) {
      expect(u.endsWith('/')).toBe(true);
    }
  });
  it('routes seed threads statically and db threads dynamically', () => {
    expect(url.forumThread('t-announce')).toBe('/forum/t/t-announce/');
    expect(url.forumThread('c81da701-f3a9-4232-87a9-009351953263')).toBe(
      '/forum/t/?id=c81da701-f3a9-4232-87a9-009351953263',
    );
    expect(url.search('塔防')).toBe('/search/?q=%E5%A1%94%E9%98%B2');
    expect(relatedUrl('app', 'fablemotion')).toBe('/apps/fablemotion/');
    expect(ogArt('game-4')).toBe('/og/art/game-4.png');
  });
});

describe('seo', () => {
  it('builds absolute breadcrumb items', () => {
    const b = breadcrumbs([
      { name: '首页', path: '/' },
      { name: '应用', path: '/apps/' },
    ]) as { itemListElement: { item: string; position: number }[] };
    expect(b.itemListElement[1]).toMatchObject({ position: 2, item: 'https://azsou.com/apps/' });
  });
  it('never emits ratings for software (no fake metrics)', () => {
    const s = softwareApp({
      name: 'X',
      description: 'd',
      path: '/apps/x/',
      category: '工具',
      version: '1.0',
    });
    expect(s).not.toHaveProperty('aggregateRating');
    expect(s).not.toHaveProperty('offers');
  });
  it('serializes JSON-LD without breaking out of <script>', () => {
    expect(jsonLd({ t: '</script><script>alert(1)</script>' })).not.toContain('</script>');
  });
  it('builds article dates as ISO', () => {
    const a = article({
      title: 't',
      description: 'd',
      path: '/articles/a/',
      date: '2026-07-19',
      modified: '2026-07-20',
      image: '/og/a.png',
      section: 's',
      keywords: [],
    });
    expect(a.datePublished).toBe('2026-07-19T00:00:00.000Z');
    expect(a.image).toBe('https://azsou.com/og/a.png');
  });
});

describe('tags', () => {
  it('has ASCII slugs and Chinese names', () => {
    for (const slug of Object.keys(TAGS)) expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(tagName('dev-practice')).toBe('开发实践');
    expect(tagName('unknown')).toBe('unknown');
  });
});
