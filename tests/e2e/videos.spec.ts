import type { Page, Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

/**
 * T6.7 视频栏目 /videos/：网格 + 分类标签页、时长 / 频道筛选（查询串可分享、可恢复）、
 * 详情页的隐私 facade（点击之前不向视频平台发任何请求，点击后才插入 youtube-nocookie.com 的 iframe）、
 * 章节跳转、结构化数据（VideoObject 只含核实字段）、评论 page_key = video:<slug>、sitemap 与站内搜索。
 */

const VIDEO_HOSTS =
  /youtube(-nocookie)?\.com|ytimg\.com|googlevideo\.com|bilibili\.com|hdslb\.com|doubleclick\.net/;
/** 记录发往视频平台的请求（播放器域名用假页面应答，测试不连外网） */
async function watchVideoRequests(page: Page) {
  const hits: string[] = [];
  page.on('request', (r: Request) => {
    if (VIDEO_HOSTS.test(new URL(r.url()).hostname)) hits.push(r.url());
  });
  await page.route('https://www.youtube-nocookie.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>player</title><p>stub player</p></html>',
    }),
  );
  return hits;
}

const cards = (page: Page) => page.locator('[data-video-grid] [data-video]');
const visible = (page: Page) => page.locator('[data-video-grid] [data-video]:not([hidden])');
const ready = (page: Page) =>
  expect(page.locator('[data-video-filter]')).toHaveAttribute('data-ready', 'yes');
/** T9.12：时长 / 频道收在「更多筛选」弹层里，操作前先展开 */
const openMore = async (page: Page) => {
  const more = page.locator('[data-more-filters]');
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator('summary').click();
};

test.describe('视频列表 /videos/', () => {
  test('24 个视频、五个分类标签、版权说明、ItemList；列表页不向视频平台发请求', async ({ page, errors }) => {
    const hits = await watchVideoRequests(page);
    await page.goto('/videos/');
    await expect(page.locator('h1')).toHaveText('视频');
    await expect(cards(page)).toHaveCount(24);
    await expect(page.locator('.site-nav a[aria-current="page"]')).toHaveText('视频');
    const tabs = page.getByRole('navigation', { name: '视频分类' }).getByRole('link');
    await expect(tabs).toHaveCount(5);
    await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
    for (const name of ['AI 编程', '游戏开发', '独立游戏', '教程'])
      await expect(page.getByRole('link', { name: new RegExp(`^${name} \\d+$`) })).toBeVisible();
    await expect(page.locator('[data-video-status]')).toContainText('共 24 个视频');
    await expect(page.locator('.video-note')).toContainText('视频版权归原作者所有');
    // 没有站长本人的视频：「我的视频」区不渲染
    await expect(page.locator('#h-mine')).toHaveCount(0);
    // 卡片：标题链接到本站详情页、缩略图来自本站、有时长、没有播放量
    const card = page.locator('[data-video="designing-claude-code"]');
    await expect(card.getByRole('link', { name: 'Claude Code 是怎样设计出来的' })).toHaveAttribute(
      'href',
      '/videos/designing-claude-code/',
    );
    await expect(card.locator('img')).toHaveAttribute('src', '/videos/thumbs/designing-claude-code-480.webp');
    await expect(card.locator('.video-card__dur')).toContainText('12:04');
    await expect(page.locator('main')).not.toContainText(/\d[\d,.]*\s*(万|K|M)?\s*(次观看|次播放|views)/i);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const list = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'ItemList');
    expect(list.numberOfItems).toBe(24);
    expect(list.itemListElement[0].url).toMatch(/^https:\/\/azsou\.com\/videos\/[a-z0-9-]+\/$/);
    await page.waitForLoadState('networkidle');
    expect(hits).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('时长与频道筛选：只隐藏卡片，状态写进查询串，刷新后恢复', async ({ page, errors }) => {
    await page.goto('/videos/');
    await ready(page);
    await openMore(page);
    await page.getByRole('button', { name: '10 分钟内' }).click();
    await expect(page).toHaveURL(/\/videos\/\?len=short$/);
    await expect(page.getByRole('button', { name: '10 分钟内' })).toHaveAttribute('aria-pressed', 'true');
    const short = await visible(page).count();
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(24);
    for (const l of await visible(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.len)))
      expect(l).toBe('short');
    await expect(page.locator('[data-video-status]')).toContainText(`共 ${short} 个视频 · 10 分钟内`);

    await page.getByLabel('频道').selectOption({ label: 'Unity' });
    await expect(page).toHaveURL(/\/videos\/\?len=short&ch=unity$/);
    const both = await visible(page).evaluateAll((els) =>
      els.map((e) => [(e as HTMLElement).dataset.len, (e as HTMLElement).dataset.ch]),
    );
    expect(both.length).toBeGreaterThan(0);
    for (const pair of both) expect(pair).toEqual(['short', 'unity']);

    // 带查询串打开：按查询串恢复
    await page.reload();
    await ready(page);
    await expect(page.getByLabel('频道')).toHaveValue('unity');
    // 刷新后弹层收起（不在无障碍树里），直接查按钮的 data 属性
    await expect(page.locator('[data-video-filter] [data-len="short"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(visible(page)).toHaveCount(both.length);

    // 没有结果时显示提示；回到「全部」后恢复
    await expect(page.locator('[data-more-filters-n]')).toHaveText('2');
    await openMore(page);
    await page.getByRole('button', { name: '30 分钟以上' }).click();
    await expect(page).toHaveURL(/\?len=long&ch=unity$/);
    await expect(visible(page)).toHaveCount(0);
    await expect(page.locator('[data-video-empty]')).toBeVisible();
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByLabel('频道').selectOption('');
    await expect(page).toHaveURL(/\/videos\/$/);
    await expect(visible(page)).toHaveCount(24);
    // 非法查询串被忽略
    await page.goto('/videos/?len=huge&ch=nope');
    await ready(page);
    await expect(visible(page)).toHaveCount(24);
    expect(errors).toEqual([]);
  });

  test('分类页 /videos/category/indie/：标签高亮，只含该分类，主分类在前', async ({ page }) => {
    await page.goto('/videos/category/indie/');
    await expect(page.locator('h1')).toHaveText('独立游戏视频');
    await expect(page.getByRole('link', { name: /^独立游戏 \d+$/ })).toHaveAttribute('aria-current', 'page');
    const cats = await cards(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.cats!));
    expect(cats.length).toBeGreaterThanOrEqual(5);
    for (const c of cats) expect(c.split(' ')).toContain('indie');
    expect(cats[0].split(' ')[0]).toBe('indie');
    await expect(page.locator('nav[aria-label="面包屑"], .breadcrumbs').first()).toContainText('视频');
  });
});

test.describe('视频详情页', () => {
  test('facade：点击之前没有 iframe、不请求视频平台；点击后才加载 youtube-nocookie 播放器', async ({
    page,
    errors,
  }) => {
    const hits = await watchVideoRequests(page);
    await page.goto('/videos/designing-claude-code/');
    await expect(page.locator('h1')).toHaveText('Claude Code 是怎样设计出来的');
    await expect(page.locator('.video-detail__orig')).toContainText('Designing Claude Code');
    const box = page.locator('[data-video-facade]');
    await expect(box).toHaveAttribute('data-ready', 'yes');
    await expect(box.locator('iframe')).toHaveCount(0);
    // 无 JS 时的退路：facade 本身是指向 YouTube 的链接
    const link = box.getByRole('link', { name: /播放视频：Claude Code 是怎样设计出来的/ });
    await expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=vLIDHi-1PVU');
    await expect(box.locator('img')).toHaveAttribute('src', /^\/videos\/thumbs\/designing-claude-code-/);
    await page.waitForLoadState('networkidle');
    expect(hits).toEqual([]);

    await link.click();
    const frame = box.locator('iframe');
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/vLIDHi-1PVU?autoplay=1&rel=0&playsinline=1',
    );
    await expect(frame).toHaveAttribute('title', '视频播放器：Claude Code 是怎样设计出来的');
    await expect(frame).toHaveAttribute('allow', /autoplay/);
    await expect(box).toHaveAttribute('data-loaded', 'yes');
    await expect.poll(() => hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(new URL(h).hostname).toBe('www.youtube-nocookie.com');
    expect(errors).toEqual([]);
  });

  test('章节：点击时间点从该处加载播放器，再点另一个时间点换起始时间', async ({ page }) => {
    await watchVideoRequests(page);
    await page.goto('/videos/designing-claude-code/');
    const chapters = page.locator('[data-seek]');
    await expect(chapters).toHaveCount(8);
    await expect(chapters.first()).toBeEnabled();
    await page.getByRole('button', { name: /3:22/ }).click();
    const frame = page.locator('[data-video-facade] iframe');
    await expect(frame).toHaveAttribute('src', /\/embed\/vLIDHi-1PVU\?.*start=202/);
    await page.getByRole('button', { name: /6:45/ }).click();
    await expect(frame).toHaveAttribute('src', /start=405/);
    await expect(page.locator('[data-video-facade] iframe')).toHaveCount(1);
  });

  test('结构化数据：VideoObject 只含核实字段（无播放量）、Clip、面包屑；评论 page_key、相关视频与工具', async ({
    page,
  }) => {
    await page.goto('/videos/getting-started-with-unity-cli/');
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const graph = ld['@graph'] as Record<string, unknown>[];
    const v = graph.find((n) => n['@type'] === 'VideoObject')!;
    expect(v.name).toBe('Getting started with Unity CLI');
    expect(v.duration).toBe('PT7M6S');
    expect(v.uploadDate).toMatch(/^2026-09-17T/);
    expect(v.embedUrl).toBe('https://www.youtube-nocookie.com/embed/EaEIynRqIHU');
    expect(v.thumbnailUrl).toEqual([
      'https://azsou.com/videos/thumbs/getting-started-with-unity-cli-960.webp',
      'https://azsou.com/videos/thumbs/getting-started-with-unity-cli-480.webp',
    ]);
    expect(v).not.toHaveProperty('interactionStatistic');
    expect((v.author as { name: string }).name).toBe('Unity');
    const clips = v.hasPart as { startOffset: number; endOffset: number; url: string }[];
    expect(clips).toHaveLength(8);
    expect(clips[1]).toMatchObject({ startOffset: 74, endOffset: 128 });
    expect(clips.at(-1)!.endOffset).toBe(426);
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList') as {
      itemListElement: { name: string }[];
    };
    expect(crumbs.itemListElement.map((i) => i.name)).toEqual([
      '首页',
      '视频',
      '教程',
      'Unity CLI 入门：让 AI 智能体直接驱动编辑器',
    ]);
    await expect(page.locator('.video-copyright')).toContainText('视频版权归原作者所有（Unity）');
    await expect(page.locator('[data-comments]')).toHaveAttribute(
      'data-page-key',
      'video:getting-started-with-unity-cli',
    );
    await expect(page.locator('#h-tools')).toBeVisible();
    await expect(
      page.locator('section:has(#h-tools)').getByRole('link', { name: 'Claude Code' }),
    ).toHaveAttribute('href', '/ai/claude-code/');
    await expect(page.locator('section:has(#h-related) [data-video]')).toHaveCount(3);
  });

  test('点击加载播放器后页面仍无障碍违规（axe，排除第三方 iframe 内部）', async ({ page }, info) => {
    test.skip(!/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
    await watchVideoRequests(page);
    await page.goto('/videos/godot-2025-showreel/');
    await page.locator('[data-facade-link]').click();
    await expect(page.locator('[data-video-facade] iframe')).toHaveCount(1);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('[data-video-facade] iframe')
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
  });

  test('sitemap 收录视频页；站内搜索能搜到视频', async ({ page, request }) => {
    const sm = await (await request.get('/sitemap-0.xml')).text();
    for (const u of ['/videos/', '/videos/designing-claude-code/', '/videos/category/gamedev/'])
      expect(sm).toContain(`https://azsou.com${u}`);
    const index = (await (await request.get('/search-index.json')).json()) as { type: string; url: string }[];
    expect(index.filter((i) => i.type === 'video')).toHaveLength(24);
    await page.goto('/search/?q=MegaLights');
    await expect(
      page.locator('main a[href="/videos/unreal-megalights-artist-guide/"]').first(),
    ).toBeVisible();
  });
});
