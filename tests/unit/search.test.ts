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

describe('T9.13 排序、错拼建议、摘要清理', async () => {
  const { score: sc, suggest, editDistance, tidyExcerpt, search: run } = await import('@/lib/search');
  const items = [
    { type: 'page' as const, title: 'Code of conduct', url: '/conduct/' },
    { type: 'article' as const, title: '用 AI 写代码的检查清单', url: '/a/', summary: 'code review 清单' },
    { type: 'tool' as const, title: 'Codex CLI', url: '/ai/codex-cli/' },
    { type: 'tool' as const, title: 'Claude Code', url: '/ai/claude-code/' },
    { type: 'tool' as const, title: 'Claude', url: '/ai/claude/' },
  ];
  it('「code」：首条是 Claude Code / Codex CLI（标题前缀与整词同档，按实体类型排），正文命中最后', () => {
    const top = run(items, 'code').map((x) => x.title);
    expect(top.slice(0, 2).sort()).toEqual(['Claude Code', 'Codex CLI']);
    expect(top[2]).toBe('Code of conduct');
    expect(top.at(-1)).toBe('用 AI 写代码的检查清单');
    expect(sc(items[3], 'code')).toBeGreaterThan(sc(items[0], 'code'));
  });
  it('编辑距离（含相邻换位）', () => {
    expect(editDistance('cluade', 'claude')).toBe(1);
    expect(editDistance('qwzxv', 'claude')).toBeGreaterThan(2);
  });
  it('「cluade」建议「Claude」；「qwzxv」没有建议；已有强命中不建议', () => {
    expect(suggest(items, 'cluade')).toBe('Claude');
    expect(suggest(items, 'qwzxv')).toBeNull();
    expect(suggest(items, 'claude')).toBeNull();
  });
  it('摘要不出现「中文. 」连接', () => {
    expect(tidyExcerpt('时间轴动画编辑器. 支持导出')).toBe('时间轴动画编辑器 支持导出');
    expect(tidyExcerpt('Node.js. Next')).toBe('Node.js. Next');
  });
});
