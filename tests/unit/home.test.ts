/**
 * T6.8 首页：区块数据整理（纯函数）+ 「没有数据就隐藏」+ 不出现伪造指标 + 首页 HTML 的结构化数据 / 区块（构建产物存在时）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  HOME_SECTIONS,
  categoryTiles,
  featuredItemList,
  featuredItems,
  homeSections,
  homeVideos,
  latestByDate,
  latestThreads,
  missingPlatforms,
  newReleases,
  quickChips,
  recentUpdates,
  toolsByEditorOrder,
  TRY_QUERIES,
  appBrand,
  brandKey,
  iconWall,
  toolBrand,
  type HomeApp,
  type HomeCounts,
  type HomeGame,
  type HomeTool,
} from '@/lib/home';

const icon = (s: string) => ({ src: `/apps/icons/${s}.png`, variants: true });
const app = (id: string, d: Partial<HomeApp['data']> = {}): HomeApp => ({
  id,
  data: {
    title: id.toUpperCase(),
    subtitle: `${id} 副标题`,
    summary: `${id} 简介`,
    icon: icon(id),
    hue: 'blue',
    category: 'utilities',
    platforms: [{ os: 'web' }],
    featured: false,
    version: '1.0',
    order: 1,
    ...d,
  },
});
const tool = (id: string, d: Partial<HomeTool['data']> = {}): HomeTool => ({
  id,
  data: {
    title: id,
    subtitle: `${id} 副标题`,
    summary: `${id} 简介`,
    icon: { src: `/ai/icons/${id}.png`, variants: true },
    categories: ['agent'],
    platforms: [{ os: 'cli' }],
    featured: false,
    order: 1,
    ...d,
  },
});
const game = (id: string, date: string, order = 1): HomeGame => ({
  id,
  data: { title: id, hue: 'orange', version: '0.1', date, order, kind: '可玩 Demo' },
});

describe('featuredItems', () => {
  it('精选应用在前、精选工具在后，各自按 order；未精选的不出现', () => {
    const items = featuredItems(
      [app('b', { featured: true, order: 2 }), app('a', { featured: true, order: 1 }), app('c')],
      [tool('t2', { featured: true, order: 5 }), tool('t1', { featured: true, order: 3 }), tool('t3')],
    );
    expect(items.map((i) => i.slug)).toEqual(['a', 'b', 't1', 't2']);
    expect(items[0]).toMatchObject({ kind: 'app', url: '/apps/a/', label: '自研应用 · 效率工具' });
    expect(items[2]).toMatchObject({
      kind: 'tool',
      url: '/ai/t1/',
      label: 'AI 工具 · AI Agent',
      hue: 'blue',
    });
  });
  it('没有精选 → 空数组', () => {
    expect(featuredItems([app('a')], [tool('t')])).toEqual([]);
  });
  it('ItemList 结构化数据', () => {
    const list = featuredItemList(
      featuredItems([app('a', { featured: true })], []),
      (p) => `https://x.test${p}`,
    );
    expect(list).toMatchObject({
      '@type': 'ItemList',
      numberOfItems: 1,
      itemListElement: [{ '@type': 'ListItem', position: 1, name: 'A', url: 'https://x.test/apps/a/' }],
    });
  });
});

describe('quickChips', () => {
  it('只列有自研应用的平台（目录页才存在）+ 有工具的 AI 分类，附真实数量', () => {
    const chips = quickChips(
      [app('a', { platforms: [{ os: 'web' }, { os: 'windows' }] }), app('b', { platforms: [{ os: 'web' }] })],
      [tool('t1', { categories: ['agent', 'mcp'] }), tool('t2', { categories: ['mcp'] })],
    );
    expect(chips).toEqual([
      { label: 'Windows', url: '/apps/platform/windows/', count: 1, kind: 'platform' },
      { label: 'Web', url: '/apps/platform/web/', count: 2, kind: 'platform' },
      { label: 'AI Agent', url: '/ai/category/agent/', count: 1, kind: 'ai' },
      { label: 'MCP', url: '/ai/category/mcp/', count: 2, kind: 'ai' },
    ]);
  });
  it('没有任何条目 → 没有快捷入口；缺少的平台可列出', () => {
    expect(quickChips([], [])).toEqual([]);
    expect(missingPlatforms([app('a', { platforms: [{ os: 'web' }] })])).toEqual([
      'ios',
      'android',
      'windows',
      'macos',
      'linux',
      'cli',
      'browser-ext',
    ]);
  });
});

describe('列表与排序', () => {
  it('AI 工具按编辑顺序，截取 n 个', () => {
    const ts = [tool('c', { order: 3 }), tool('a', { order: 1 }), tool('b', { order: 2 })];
    expect(toolsByEditorOrder(ts, 2).map((t) => t.id)).toEqual(['a', 'b']);
  });
  it('最新上架只看 releaseDate；都没有 → 空（区块隐藏）', () => {
    expect(newReleases([app('a'), app('b')])).toEqual([]);
    const r = newReleases([
      app('a', { releaseDate: '2026-01-02' }),
      app('b'),
      app('c', { releaseDate: '2026-03-01' }),
    ]);
    expect(r.map((a) => a.id)).toEqual(['c', 'a']);
  });
  it('最近更新：应用 updated + 游戏 date，新的在前，没写日期的不进来', () => {
    const rows = recentUpdates(
      [app('a', { updated: '2026-07-18' }), app('nodate')],
      [game('g1', '2026-07-19'), game('g2', '2026-06-01')],
      3,
    );
    expect(rows.map((r) => [r.kind, r.slug, r.date])).toEqual([
      ['game', 'g1', '2026-07-19'],
      ['app', 'a', '2026-07-18'],
      ['game', 'g2', '2026-06-01'],
    ]);
    expect(rows[1]).toMatchObject({ url: '/apps/a/', icon: icon('a') });
    expect(rows[0].icon).toBeUndefined();
    expect(recentUpdates([app('x')], [])).toEqual([]);
  });
  it('分类入口只列有条目的分类，数量真实，图标最多 3 个', () => {
    const tiles = categoryTiles(
      [app('a', { category: 'creative' }), app('b', { category: 'creative' })],
      [1, 2, 3, 4].map((i) => tool(`t${i}`, { categories: ['cli'], order: i })),
    );
    expect(tiles.map((t) => [t.kind, t.id, t.count, t.icons.length, t.url])).toEqual([
      ['app', 'creative', 2, 2, '/apps/category/creative/'],
      ['ai', 'cli', 4, 3, '/ai/category/cli/'],
    ]);
    expect(categoryTiles([], [])).toEqual([]);
  });
  it('视频：精选在前（order），再按发布时间补齐', () => {
    const v = (id: string, featured: boolean, order: number, published?: string) => ({
      id,
      data: { featured, order, published },
    });
    const out = homeVideos(
      [
        v('old', false, 1, '2025-01-01T00:00:00Z'),
        v('f2', true, 9),
        v('new', false, 2, '2026-10-01T00:00:00Z'),
        v('f1', true, 3),
        v('nodate', false, 0),
      ],
      4,
    );
    expect(out.map((x) => x.id)).toEqual(['f1', 'f2', 'new', 'old']);
  });
  it('按日期倒序（同日按 order）与论坛最新', () => {
    const xs = [
      { id: 'a', data: { date: '2026-06', order: 2 } },
      { id: 'b', data: { date: '2026-07', order: 5 } },
      { id: 'c', data: { date: '2026-06', order: 1 } },
    ];
    expect(latestByDate(xs, 3).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    const th = latestThreads(
      [
        { id: 't-1', date: '2026-07-01', title: '1', category: 'x' },
        { id: 't-2', date: '2026-07-03', title: '2', category: 'x' },
      ],
      1,
    );
    expect(th.map((t) => t.id)).toEqual(['t-2']);
  });
});

describe('homeSections：没有数据的区块整块隐藏', () => {
  const full = Object.fromEntries(HOME_SECTIONS.map((id) => [id, 3])) as HomeCounts;
  it('全部有数据 → 按页面顺序全部显示', () => {
    expect(homeSections(full)).toEqual([...HOME_SECTIONS]);
  });
  it('数量为 0 的区块不返回（不放占位框）', () => {
    expect(homeSections({ ...full, new: 0, videos: 0, forum: 0 })).toEqual(
      HOME_SECTIONS.filter((s) => !['new', 'videos', 'forum'].includes(s)),
    );
    expect(homeSections(Object.fromEntries(HOME_SECTIONS.map((id) => [id, 0])) as HomeCounts)).toEqual([]);
  });
});

describe('hero 图标墙（iconWall）', () => {
  const w = (href: string, src: string, brand: string) => ({
    title: href,
    href,
    brand,
    icon: { src, variants: true },
  });
  it('同一链接 / 图标文件 / 品牌只出现一次，并截到 n 个', () => {
    const out = iconWall(
      [
        w('/a/', '/apps/icons/a.png', 'self:a'),
        w('/a/', '/apps/icons/a.png', 'self:a'),
        w('/ai/chatgpt/', '/ai/icons/chatgpt.png', 'openai'),
        w('/ai/codex-cli/', '/ai/icons/codex-cli.png', 'openai'),
        w('/ai/x/', '/ai/icons/chatgpt.png', 'x'),
        w('/ai/y/', '/ai/icons/y.png', 'y'),
        w('/ai/z/', '/ai/icons/z.png', 'z'),
      ],
      3,
    );
    expect(out.map((o) => o.href)).toEqual(['/a/', '/ai/chatgpt/', '/ai/y/']);
  });
  it('按图片内容去重：ChatGPT 与 Codex CLI 用的是同一个 OpenAI 标志', () => {
    const fp = (src: string) =>
      createHash('sha1')
        .update(fs.readFileSync(`public${src.replace(/\.png$/, '-64.webp')}`))
        .digest('hex');
    const out = iconWall(
      [
        w('/ai/codex-cli/', '/ai/icons/codex-cli.png', 'b1'),
        w('/ai/chatgpt/', '/ai/icons/chatgpt.png', 'b2'),
        w('/ai/cursor/', '/ai/icons/cursor.png', 'b3'),
      ],
      12,
      fp,
    );
    expect(out.map((o) => o.href)).toEqual(['/ai/codex-cli/', '/ai/cursor/']);
  });
  it('品牌键：去掉括号补充、大小写无关；自研应用按 slug 区分', () => {
    expect(brandKey('GitHub（Microsoft）')).toBe('github');
    expect(brandKey('OpenAI')).toBe(brandKey('openai'));
    expect(appBrand(app('a'))).toBe('self:a');
    expect(appBrand(app('b', { developer: { name: 'Vendor (Inc)', type: 'third-party' } }))).toBe('vendor');
    expect(toolBrand(tool('t', { developer: { name: 'Anthropic' } }))).toBe('anthropic');
  });
  it('「试试」关键词是有意义的词，不是拼音缩写', () => {
    expect(TRY_QUERIES).toEqual(['动画编辑器', 'Cursor', '塔防', 'MCP']);
    for (const q of TRY_QUERIES) expect(q).not.toMatch(/^[a-z]{4,}$/);
  });
});

describe('首页源码与构建产物', () => {
  const src = fs.readFileSync('src/pages/index.astro', 'utf8');
  it('不出现伪造的评分 / 下载量 / 用户数，也没有广告占位', () => {
    expect(src).not.toMatch(/ratingValue|aggregateRating|下载量\s*\d|\d+\s*万次|用户数\s*\d|AdSlot|广告位/);
  });
  const html = fs.existsSync('dist/client/index.html')
    ? fs.readFileSync('dist/client/index.html', 'utf8')
    : '';
  it.skipIf(!html)('结构化数据：WebSite + SearchAction、Person、Organization、ItemList', () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const types = ld['@graph'].map((n: { '@type': string }) => n['@type']);
    expect(types).toEqual(expect.arrayContaining(['WebSite', 'Person', 'Organization', 'ItemList']));
    const site = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'WebSite');
    expect(site.potentialAction['@type']).toBe('SearchAction');
  });
  it.skipIf(!html)('图标墙没有重复的 logo（按图片内容）', () => {
    const wall = /<ul class="icon-wall"[\s\S]*?<\/ul>/.exec(html)![0];
    const srcs = [...wall.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBe(12);
    const hashes = srcs.map((s) =>
      createHash('sha1')
        .update(fs.readFileSync(`public${s}`))
        .digest('hex'),
    );
    expect(new Set(hashes).size).toBe(srcs.length);
  });
  // T9.4（DESIGN-SYSTEM §19.3）：首屏图片 eager（设计测试 Q18 断言首屏无 lazy），其余懒加载；eager 只给小图标，数量有上限
  it.skipIf(!html)('首页 eager 图片只有首屏图标（≤ 32 张小图标），其余懒加载', () => {
    const eager = [...html.matchAll(/<img[^>]*loading="eager"[^>]*>/g)].map((m) => m[0]);
    expect(eager.length).toBeLessThanOrEqual(32);
    for (const tag of eager) expect(tag, tag).toMatch(/class="app-icon-img/);
    expect(html).toMatch(/<img[^>]*loading="lazy"/);
  });
});
