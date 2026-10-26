import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * T6.6 AI 工具栏目 /ai/：瀑布流列表、分类标签页、价格 / 开源筛选（查询串可分享、可恢复）、
 * 详情页（复用应用详情布局：第三方标识、只链官方地址、结构化数据、评论 page_key = tool:<slug>）、
 * 下载中转 /go/<工具>/<平台>/（与应用共用计数 RPC）。
 */

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

const cards = (page: Page) => page.locator('[data-ai-grid] [data-tool]');
const visible = (page: Page) => page.locator('[data-ai-grid] [data-tool]:not([hidden])');
const ready = (page: Page) => expect(page.locator('[data-ai-filter]')).toHaveAttribute('data-ready', 'yes');
/** T9.12：价格 / 开源收在「更多筛选」弹层里，操作前先展开 */
const openMore = async (page: Page) => {
  const more = page.locator('[data-more-filters]');
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) await more.locator('summary').click();
};

test.describe('AI 工具列表 /ai/', () => {
  test('30 个工具、五个分类标签、只链官方地址的说明、ItemList 结构化数据', async ({ page, errors }) => {
    await page.goto('/ai/');
    await expect(page.locator('h1')).toHaveText('AI 工具');
    await expect(cards(page)).toHaveCount(30);
    await expect(page.locator('.site-nav a[aria-current="page"]')).toHaveText('AI 工具');
    const tabs = page.getByRole('navigation', { name: 'AI 工具分类' }).getByRole('link');
    await expect(tabs).toHaveCount(6);
    await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
    await expect(tabs.first()).toContainText('30');
    for (const name of ['AI Agent', 'Vibe Coding', 'CLI 工具', 'AI Bot', 'MCP'])
      await expect(page.getByRole('link', { name: new RegExp(`^${name} \\d+$`) })).toBeVisible();
    await expect(page.locator('[data-ai-status]')).toContainText('共 30 个工具');
    await expect(page.locator('.ai-note')).toContainText('图标版权归各自所有者');
    // 卡片：标题链接到本站详情页，图标来自本站
    const claude = page.locator('[data-tool="claude-code"]');
    await expect(claude.getByRole('link', { name: 'Claude Code', exact: true })).toHaveAttribute(
      'href',
      '/ai/claude-code/',
    );
    // P10 主操作：经 /go/ 中转页去官方渠道（不托管安装包）
    await expect(claude.locator('.entry__action')).toHaveAttribute('href', /^\/go\/claude-code\//);
    // T6.9 / T9.3：<picture>（AVIF + WebP 1x / 2x）；P10 格子图标 72 px 用 72 / 144 两档（规范化管线 /icons/n/）
    await expect(claude.locator('img')).toHaveAttribute('src', /^\/ai\/icons\/n\/claude-code-144\.webp$/);
    await expect(claude.locator('img')).toHaveAttribute('srcset', /claude-code-144\.webp 2x$/);
    await expect(claude.locator('picture source[type="image/avif"]')).toHaveAttribute(
      'srcset',
      /claude-code-72\.avif 1x/,
    );
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const list = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'ItemList');
    expect(list.numberOfItems).toBe(30);
    expect(list.itemListElement[0].url).toMatch(/^https:\/\/azsou\.com\/ai\/[a-z0-9-]+\/$/);
    expect(errors).toEqual([]);
  });

  test('价格与开源筛选：只隐藏卡片，状态写进查询串，刷新后恢复', async ({ page, errors }) => {
    await page.goto('/ai/');
    await ready(page);
    const total = await cards(page).count();
    await expect(page.locator('[data-more-filters] summary')).toContainText('更多筛选');
    await openMore(page);
    await page.getByRole('button', { name: '免费', exact: true }).click();
    await expect(page).toHaveURL(/\/ai\/\?price=free$/);
    await expect(page.getByRole('button', { name: '免费', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const free = await visible(page).count();
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThan(total);
    for (const p of await visible(page).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.price),
    ))
      expect(p).toBe('free');
    await expect(page.locator('[data-ai-status]')).toContainText(`共 ${free} 个工具 · 免费`);
    await expect(page.locator('[data-more-filters-n]')).toHaveText('1');

    await page.getByLabel(/只看开源/).check();
    await expect(page).toHaveURL(/\/ai\/\?price=free&oss=1$/);
    const both = await visible(page).evaluateAll((els) =>
      els.map((e) => [(e as HTMLElement).dataset.price, (e as HTMLElement).dataset.oss]),
    );
    expect(both.length).toBeGreaterThan(0);
    for (const [p, o] of both) expect([p, o]).toEqual(['free', '1']);
    await expect(page.locator('[data-more-filters-n]')).toHaveText('2');

    // 带查询串打开：按查询串恢复
    await page.reload();
    await ready(page);
    await expect(page.getByLabel(/只看开源/)).toBeChecked();
    await expect(visible(page)).toHaveCount(both.length);

    // 回到全部（刷新后弹层收起，摘要仍显示生效条件数）
    await expect(page.locator('[data-more-filters-n]')).toHaveText('2');
    await openMore(page);
    await page.getByRole('button', { name: '全部', exact: true }).click();
    await page.getByLabel(/只看开源/).uncheck();
    await expect(page).toHaveURL(/\/ai\/$/);
    await expect(visible(page)).toHaveCount(total);
    await expect(page.locator('[data-more-filters-n]')).toBeHidden();
    // Esc 收起弹层，焦点回到摘要
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-more-filters]')).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-more-filters] summary')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('非法查询串被忽略；没有结果时显示空状态', async ({ page }) => {
    await page.goto('/ai/?price=gratis&oss=maybe');
    await ready(page);
    await expect(visible(page)).toHaveCount(30);
    await page.goto('/ai/category/mcp/?price=paid');
    await ready(page);
    // MCP 分类里没有付费工具：价格按钮里没有「付费」，查询串里的付费被忽略
    await expect(page.getByRole('button', { name: '付费', exact: true })).toHaveCount(0);
    await expect(visible(page)).toHaveCount(4);
    await openMore(page);
    await page.getByLabel(/只看开源/).check();
    await expect(visible(page)).toHaveCount(4);
    await expect(page.locator('[data-ai-empty]')).toBeHidden();
  });

  test('分类页：静态生成、主分类在前、标签高亮、面包屑', async ({ page }) => {
    await page.goto('/ai/category/mcp/');
    await expect(page.locator('h1')).toHaveText('MCP 工具');
    await expect(cards(page)).toHaveCount(4);
    await expect(
      page.getByRole('navigation', { name: 'AI 工具分类' }).locator('[aria-current="page"]'),
    ).toContainText('MCP');
    const slugs = await cards(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tool));
    expect(slugs.slice(0, 3).sort()).toEqual(['github-mcp-server', 'mcp-servers', 'playwright-mcp']);
    expect(slugs).toContain('goose');
    await page.goto('/ai/category/cli/');
    for (const c of await cards(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.cats)))
      expect(c).toContain('cli');
  });
});

test.describe('AI 工具详情 /ai/<slug>/', () => {
  test('Ollama：第三方标识、官方地址经 /go/ 中转、原创介绍、信息表、结构化数据、评论 page_key', async ({
    page,
    errors,
  }) => {
    await page.goto('/ai/ollama/');
    await expect(page.locator('h1')).toHaveText('Ollama');
    await expect(page.locator('.app-hero__dev .badge')).toHaveText('第三方开发者');
    const dl = page.locator('[data-downloads] a[data-has-url]');
    await expect(dl).toHaveCount(3);
    for (const href of await dl.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      expect(href).toMatch(/^\/go\/ollama\/(macos|windows|linux)\/$/);
    await expect(page.locator('[data-dl-hint]')).toContainText(/外链提示页|推荐/);
    await expect(page.locator('#h-about')).toHaveText('介绍与点评');
    expect(await page.locator('#h-about + .prose p').count()).toBeGreaterThanOrEqual(3);
    const info = page.locator('section:has(#h-info) .info-table');
    await expect(info).toContainText('图标版权归各自所有者');
    await expect(info).toContainText(/MIT\s*（开源）/);
    await expect(info).toContainText('ollama.com');
    await expect(info).toContainText('最后核对');
    // 版本跟随官方：指标条不写版本格（没有真实值的字段整项省略，T10.11）；不放评分
    const metrics = page.locator('[data-detail-metrics]');
    await expect(metrics.locator('[data-metric="version"]')).toHaveCount(0);
    await expect(metrics.locator('dt')).toHaveText(['平台', '价格', '许可']);
    await expect(metrics).not.toContainText(/评分|随官方更新|—/);
    // T10.14 AI 专属字段：只显示填了的项
    const ai = page.locator('[data-ai-facts]');
    await expect(ai.locator('[data-ai="freeTier"] dd')).toHaveText('本地运行免费');
    await expect(ai.locator('[data-ai="api"] dd')).toHaveText('本地 OpenAI 兼容 API');
    await expect(ai.locator('[data-ai="mcp"], [data-ai="china"]')).toHaveCount(0);
    await expect(ai.locator('[data-ai="entry"] a')).toHaveAttribute('href', 'https://ollama.com/');
    // T10.12 安全与来源说明
    await expect(page.locator('[data-source-note]')).toContainText('链接指向官方渠道，本站不托管安装包');
    // 没有截图区、没有「迁移补建」提示
    await expect(page.locator('#h-shots')).toHaveCount(0);
    await expect(page.locator('.notice[role="note"]')).toHaveCount(0);
    // 评论挂在 tool:ollama；相关工具
    await expect(page.locator('[data-comments]')).toHaveAttribute('data-page-key', 'tool:ollama');
    // T10.13 导流区：同类替代（AppMini 条目）
    await expect(page.locator('#h-alt')).toHaveText('同类替代');
    expect(await page.locator('[data-detail-side] section:has(#h-alt) [data-entry]').count()).toBeGreaterThan(
      0,
    );
    // JSON-LD
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const appNode = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication');
    expect(appNode).toMatchObject({
      name: 'Ollama',
      url: 'https://azsou.com/ai/ollama/',
      author: { '@type': 'Organization', name: 'Ollama' },
      sameAs: 'https://github.com/ollama/ollama',
    });
    expect(appNode).not.toHaveProperty('softwareVersion');
    expect(appNode).not.toHaveProperty('aggregateRating');
    const crumbs = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'BreadcrumbList');
    expect(crumbs.itemListElement.map((i: { name: string }) => i.name)).toEqual([
      '首页',
      'AI 工具',
      'CLI 工具',
      'Ollama',
    ]);
    expect(errors).toEqual([]);
  });

  test('只有网页版的工具：按钮文字是「打开」，hint 不说「没有某某版本」', async ({ page }) => {
    await page.goto('/ai/lovable/');
    const btn = page.locator('[data-downloads] a[data-has-url]');
    await expect(btn).toHaveCount(1);
    await expect(btn).toContainText('打开');
    await expect(btn).toHaveAttribute('href', '/go/lovable/web/');
    await expect(page.locator('[data-dl-hint]')).not.toContainText('没有');
  });
});

test.describe('AI 工具的下载中转 /go/', () => {
  test('外链提示指向官方域名，点击后先计数（工具 slug）再跳转；返回工具页', async ({ page, errors }) => {
    const calls: unknown[] = [];
    await page.route('**/rest/v1/rpc/app_count_download', (route) => {
      calls.push(route.request().postDataJSON());
      return json(route, 7);
    });
    await page.route('https://ollama.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>ollama</title>' }),
    );
    await page.goto('/go/ollama/macos/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('h1')).toHaveText('Ollama');
    await expect(page.locator('[role="note"]')).toContainText('ollama.com');
    await expect(page.locator('[role="note"]')).toContainText('第三方开发者 Ollama 的官方渠道');
    await expect(page.locator('[data-sha]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '返回工具页' })).toHaveAttribute('href', '/ai/ollama/');
    await expect(page.locator('.breadcrumbs, nav[aria-label="面包屑"]').first()).toContainText('AI 工具');
    await expect(page.locator('[data-go-page]')).toHaveAttribute('data-ready', 'yes');
    await page.getByRole('link', { name: /继续前往 ollama\.com/ }).click();
    await page.waitForURL('https://ollama.com/download');
    expect(calls).toEqual([{ p_app: 'ollama', p_platform: 'macos' }]);
    expect(errors).toEqual([]);
  });

  test('sitemap 收录 /ai/ 页面但不收录 /go/；站内搜索能搜到工具', async ({ page, request }) => {
    const sm = await (await request.get('/sitemap-0.xml')).text();
    for (const u of ['/ai/', '/ai/claude-code/', '/ai/category/mcp/'])
      expect(sm).toContain(`https://azsou.com${u}`);
    expect(sm).not.toContain('/go/ollama/');
    const index = (await (await request.get('/search-index.json')).json()) as { type: string; url: string }[];
    expect(index.filter((i) => i.type === 'tool')).toHaveLength(30);
    await page.goto('/search/?q=ollama');
    await expect(page.locator('main a[href="/ai/ollama/"]').first()).toBeVisible();
  });
});
