import { describe, expect, it } from 'vitest';
import { normalize, score, search, type SearchItem } from '@/lib/search';

const items: SearchItem[] = [
  {
    type: 'app',
    title: '单文件工具箱',
    url: '/apps/single-file-toolbox/',
    pinyin: 'dwjgjx',
    summary: '下载后直接运行的实用工具集合。',
  },
  { type: 'game', title: '声波塔防', url: '/games/audio-tower-defense/', pinyin: 'sbtf' },
  { type: 'app', title: 'FableMotion', url: '/apps/fablemotion/', summary: '动画与视频编辑器' },
  {
    type: 'article',
    title: '拼音首字母搜索：不引库的 30 行实现与取舍',
    url: '/articles/pinyin-initial-search/',
    pinyin: 'pyszmssbykd30hsxyqs',
  },
];

describe('search', () => {
  it('normalizes full-width and case', () => {
    expect(normalize('  ＦａｂｌｅMotion  ')).toBe('fablemotion');
  });
  it('matches pinyin initials exactly and by prefix (V63 行为)', () => {
    expect(search(items, 'dwjgjx')[0].title).toBe('单文件工具箱');
    expect(search(items, 'dwj').map((i) => i.title)).toContain('单文件工具箱');
    expect(search(items, 'sbtf')[0].title).toBe('声波塔防');
  });
  it('matches Chinese substrings and English case-insensitively', () => {
    expect(search(items, '塔防')[0].url).toBe('/games/audio-tower-defense/');
    expect(search(items, 'fable')[0].title).toBe('FableMotion');
  });
  it('ranks title matches above summary matches', () => {
    expect(score(items[2], 'FableMotion')).toBeGreaterThan(score(items[2], '视频'));
    expect(score(items[2], '视频')).toBeGreaterThan(0);
  });
  it('returns nothing for empty or unmatched queries', () => {
    expect(search(items, '')).toEqual([]);
    expect(search(items, 'zzzz')).toEqual([]);
  });
});
