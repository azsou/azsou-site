import { describe, expect, it } from 'vitest';
import {
  fillReport,
  fromApp,
  fromGame,
  fromTool,
  latestUpdated,
  metaParts,
  sortEntries,
  versionText,
  type StoreAppInput,
  type StoreGameInput,
  type StoreToolInput,
} from '@/lib/store';

const app = (over: Partial<StoreAppInput['data']> = {}, id = 'a1'): StoreAppInput => ({
  id,
  data: {
    title: '应用甲',
    tagline: '一句话说明这款应用',
    icon: { src: '/apps/icons/a1.png', variants: true },
    hue: 'blue',
    developer: { name: 'Randy Hopkins', type: 'self' },
    category: 'creative',
    platforms: [{ os: 'web', linkType: 'official' }],
    price: { model: 'free' },
    license: '保留所有权利（免费使用）',
    openSource: false,
    version: '1.2',
    order: 1,
    ...over,
  },
});
const tool = (over: Partial<StoreToolInput['data']> = {}, id = 't1'): StoreToolInput => ({
  id,
  data: {
    title: 'Tool',
    tagline: '终端里的编程助手',
    icon: { src: '/ai/icons/t1.png', variants: true },
    developer: { name: 'Acme' },
    categories: ['cli'],
    platforms: [{ os: 'cli', linkType: 'github', url: 'https://github.com/acme/tool' }],
    price: { model: 'freemium' },
    license: 'MIT',
    openSource: true,
    order: 2,
    ...over,
  },
});
const game = (over: Partial<StoreGameInput['data']> = {}, id = 'g1'): StoreGameInput => ({
  id,
  data: {
    title: '塔防',
    genre: '音频塔防',
    kind: '可玩 Demo',
    hue: 'green',
    version: '0.6',
    date: '2026-07-02',
    order: 3,
    ...over,
  },
});

describe('商店条目模型（T10.1 / T10.2）', () => {
  it('应用：类型徽标、版本、更新日期取 updated 或最新更新日志；没有下载地址时主操作去详情页', () => {
    const e = fromApp(app({ updated: '2026-07-18' }));
    expect(e.typeLabel).toBe('应用');
    expect(e.meta).toMatchObject({
      version: '1.2',
      updatedAt: '2026-07-18',
      platforms: ['网页版'],
      pricing: '免费',
    });
    expect(e.action).toEqual({ label: '了解', href: '/apps/a1/', outbound: false });
    expect(fromApp(app({ changelog: [{ date: '2026-05-01' }] })).meta.updatedAt).toBe('2026-05-01');
  });

  it('没有真实值的字段整项省略，不出现 N/A / — 占位', () => {
    const e = fromApp(app({ version: '—', price: { model: 'tbd' } }));
    expect('version' in e.meta).toBe(false);
    expect('size' in e.meta).toBe(false);
    expect('pricing' in e.meta).toBe(false);
    expect('updatedAt' in e.meta).toBe(false);
    expect(metaParts(e).join(' ')).not.toMatch(/N\/A|—|未知|暂无/);
  });

  it('AI 工具：主操作经 /go/ 中转到官方渠道，按钮文字按链接类型；不出现评分字段', () => {
    const e = fromTool(tool());
    expect(e.typeLabel).toBe('AI 工具');
    expect(e.action).toEqual({ label: 'GitHub', href: '/go/t1/cli/', outbound: true });
    expect(e.meta.openSource).toBe(true);
    expect(Object.keys(e)).not.toContain('rating');
    expect(Object.keys(e.meta)).not.toContain('rating');
  });

  it('自研应用有下载地址时按钮是「获取」；大小取平台里写了的 size', () => {
    const e = fromApp(
      app({
        platforms: [{ os: 'windows', linkType: 'github', url: 'https://github.com/x/y', size: '18 MB' }],
      }),
    );
    expect(e.action.label).toBe('获取');
    expect(e.meta.size).toBe('18 MB');
  });

  it('游戏：有 playUrl 才是「试玩」；平台只写有依据的', () => {
    expect(fromGame(game()).action.label).toBe('了解');
    expect(fromGame(game({ playUrl: '/play/g1/' })).action).toEqual({
      label: '试玩',
      href: '/play/g1/',
      outbound: false,
    });
    expect(fromGame(game()).meta.platforms).toBeUndefined();
    expect(fromGame(game({ platforms: ['web'] })).meta.platforms).toEqual(['网页版']);
  });

  it('排序：最新（无日期排后）/ 名称 / 编辑推荐', () => {
    const xs = [
      fromApp(app({ title: '乙', order: 3, updated: '2026-01-01' }, 'b')),
      fromApp(app({ title: '甲', order: 1 }, 'a')),
      fromApp(app({ title: 'Alpha', order: 2, updated: '2026-06-01' }, 'c')),
    ];
    expect(sortEntries(xs, 'new').map((x) => x.slug)).toEqual(['c', 'b', 'a']);
    expect(sortEntries(xs, 'editor').map((x) => x.slug)).toEqual(['a', 'c', 'b']);
    const byName = sortEntries(xs, 'name').map((x) => x.slug);
    expect(byName.indexOf('a')).toBeLessThan(byName.indexOf('b'));
    expect(latestUpdated(xs, 5).map((x) => x.slug)).toEqual(['c', 'b']);
  });

  it('版本前缀与填充统计', () => {
    expect(versionText('1.2')).toBe('v1.2');
    expect(versionText('S3 Candidate')).toBe('S3 Candidate');
    const r = fillReport([fromApp(app()), fromTool(tool())]);
    expect(r.version).toEqual({ filled: 1, omitted: 1 });
    expect(r.size).toEqual({ filled: 0, omitted: 2 });
  });
});
