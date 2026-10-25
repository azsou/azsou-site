import type { Page, Route } from '@playwright/test';
import { test, expect, mockSupabase } from './fixtures';

/**
 * P6 应用商店（假 Supabase，结果可复现）：详情页（平台识别、真实统计显示、截图轮播 + 灯箱、结构化数据）、
 * 目录（筛选 / 排序 / 静态分页 / 查询串恢复 / 分类与平台落地页）、下载中转页（计数 RPC、外链提示、不可达时照常跳转）。
 * 夹具应用 e2e-fixture 只在 AZ_E2E_FIXTURES=1 的构建里存在（见 src/content/apps/_e2e/）。
 */

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

/** 假统计：下载数与评分（只在测试里出现） */
async function mockStats(
  page: Page,
  downloads: { app: string; platform: string; downloads: number }[],
  reviews: {
    app: string;
    reviews: number;
    average: number;
    r1?: number;
    r2?: number;
    r3?: number;
    r4?: number;
    r5?: number;
  }[],
) {
  await page.route('**/rest/v1/app_download_counts?**', (route) => {
    const u = new URL(route.request().url());
    const eq = u.searchParams.get('app')?.replace(/^eq\./, '');
    return json(route, eq ? downloads.filter((d) => d.app === eq) : downloads);
  });
  await page.route('**/rest/v1/app_review_stats?**', (route) => {
    const u = new URL(route.request().url());
    const eq = u.searchParams.get('app')?.replace(/^eq\./, '');
    const rows = reviews.map((r) => ({ r1: 0, r2: 0, r3: 0, r4: 0, r5: 0, ...r }));
    return json(route, eq ? rows.filter((r) => r.app === eq) : rows);
  });
}

const cards = (page: Page) => page.locator('[data-catalog-grid] .app-card');
const titles = async (page: Page) =>
  (await cards(page).locator('.card__title').allTextContents()).map((t) => t.trim());
const catalogReady = (page: Page) =>
  expect(page.locator('[data-catalog-filter]')).toHaveAttribute('data-ready', 'yes');

test.describe('应用详情页', () => {
  test('FableMotion：头部（真实图标）、即将推出 + 上线通知、暂无评分、版本历史、结构化数据', async ({
    page,
    errors,
  }) => {
    await page.goto('/apps/fablemotion/');
    await expect(page.locator('h1')).toHaveText('FableMotion');
    await expect(page.locator('.app-hero__subtitle')).toHaveText('时间轴与关键帧动画编辑器');
    // 真实图标：<picture> 输出 AVIF / WebP 的 1x / 2x，不是临时图标
    const icon = page.locator('.app-hero .app-icon-img');
    await expect(icon).toHaveAttribute(
      'srcset',
      /fablemotion-112\.webp 1x, \/apps\/icons\/n\/fablemotion-224\.webp 2x/,
    );
    await expect(page.locator('.app-hero source[type="image/avif"]')).toHaveAttribute(
      'srcset',
      /fablemotion-224\.avif 2x/,
    );
    expect(await icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(page.locator('.app-hero__icon-note')).toHaveCount(0);
    // 还没有安装包（T9.12）：主按钮是「上线时通知我」（不画禁用按钮），两个平台写成「计划平台」文字
    const soon = page.locator('[data-planned] .dl-off--soon');
    await expect(soon).toHaveCount(2);
    await expect(soon.first()).toContainText('即将推出');
    await expect(page.locator('[data-downloads] [aria-disabled]')).toHaveCount(0);
    await expect(page.locator('[data-downloads] .btn--primary')).toHaveText('上线时通知我');
    await expect(page.locator('[data-downloads] a[data-has-url]')).toHaveCount(0);
    await expect(page.locator('[data-downloads] a[href^="/go/"]')).toHaveCount(0);
    await expect(page.locator('[data-notify]')).toHaveAttribute('href', '/subscribe/');
    await expect(page.locator('[data-dl-hint]')).toContainText('安装包即将推出');
    await expect(page.locator('[data-dl-hint] a').last()).toHaveAttribute(
      'href',
      '#discussion-project-fablemotion',
    );
    await expect(page.locator('#discussion-project-fablemotion')).toHaveCount(1);
    // 评分 / 下载只显示真实数据：假 Supabase 返回空 → 暂无
    await page.locator('[data-reviews]').scrollIntoViewIfNeeded(); // 评价区接近视口才加载
    await expect(page.locator('[data-reviews]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-rating-sub]')).toHaveText('暂无评分');
    await expect(page.locator('[data-downloads-total]')).toHaveText('0');
    await expect(page.locator('[data-reviews-empty]')).toBeVisible();
    await expect(page.locator('#h-history ~ ol li')).toHaveCount(3);
    await expect(page.locator('#h-new')).toBeVisible();
    // 未登录：评价区是登录引导
    await expect(page.locator('[data-reviews-compose]')).toContainText('登录后即可评分和写评价');
    // JSON-LD：SoftwareApplication，没有评分；概念图不作为 screenshot 写进结构化数据
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const app = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({
      name: 'FableMotion',
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web, Windows',
    });
    expect(app).not.toHaveProperty('aggregateRating');
    expect(app).not.toHaveProperty('screenshot');
    expect(app.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'CNY' }); // 免费
    const crumbs = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'BreadcrumbList');
    expect(crumbs.itemListElement.map((i: { name: string }) => i.name)).toEqual([
      '首页',
      '应用',
      '创作工具',
      'FableMotion',
    ]);
    expect(errors).toEqual([]);
  });

  test('截图轮播与灯箱：概念图有标注（角标、说明、alt），键盘可翻页，关闭后焦点回到截图', async ({
    page,
  }) => {
    await page.goto('/apps/fablemotion/');
    await expect(page.locator('.section__head .badge--warn')).toHaveText('概念图');
    await expect(page.locator('.shots__caption')).toContainText('概念图');
    const imgs = page.locator('[data-shot] img');
    for (const alt of await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('alt') ?? '')))
      expect(alt).toContain('概念图');
    // 桌面首屏能看到前 3 张：eager（设计测试 Q18 首屏无 lazy），之后的懒加载
    await expect(imgs.nth(2)).toHaveAttribute('loading', 'eager');
    const shots = page.locator('[data-shot]');
    await expect(shots).toHaveCount(3);
    await expect(shots.first().locator('.shot__tag')).toHaveText('概念图');
    await page.locator('[data-reviews]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-reviews]')).toHaveAttribute('data-state', /online|offline/); // island 已加载
    await shots.first().click();
    const dlg = page.locator('[data-lightbox]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('[data-lightbox-count]')).toHaveText('1 / 3');
    await expect(dlg.locator('figcaption')).toContainText('概念图');
    await dlg.getByRole('button', { name: '下一张' }).click();
    await expect(dlg.locator('[data-lightbox-count]')).toHaveText('2 / 3');
    await page.keyboard.press('ArrowRight');
    await expect(dlg.locator('[data-lightbox-count]')).toHaveText('3 / 3');
    await page.keyboard.press('ArrowRight');
    await expect(dlg.locator('[data-lightbox-count]')).toHaveText('1 / 3');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(shots.first()).toBeFocused();
  });

  test('夹具应用：按访客设备推荐下载按钮，显示真实统计（下载数相加、评分分布）', async ({ page }) => {
    await mockStats(
      page,
      [
        { app: 'e2e-fixture', platform: 'windows', downloads: 12 },
        { app: 'e2e-fixture', platform: 'web', downloads: 3 },
      ],
      [{ app: 'e2e-fixture', reviews: 2, average: 4.5, r5: 1, r4: 1 }],
    );
    await page.goto('/apps/e2e-fixture/');
    const box = page.locator('[data-downloads]');
    await expect(box.locator('a.dl-btn')).toHaveCount(2);
    await expect(page.locator('[data-planned]')).toContainText('Android');
    // 推荐：Windows UA → Windows；其余（Safari = macOS、iPhone / iPad）→ 网页版
    const ua = await page.evaluate(() => navigator.userAgent);
    const expected = /Windows/.test(ua) ? 'windows' : 'web';
    await expect(box).toHaveAttribute('data-recommended', expected);
    await expect(box.locator('.btn--primary')).toHaveCount(1);
    await expect(box.locator('.btn--primary')).toHaveAttribute('data-os', expected);
    await expect(box.locator(`[data-os="${expected}"]`)).toHaveAttribute(
      'href',
      `/go/e2e-fixture/${expected}/`,
    );
    await expect(box.locator('a.dl-btn').first()).toHaveAttribute('rel', 'nofollow');
    await expect(page.locator('[data-dl-hint]')).toContainText('推荐');
    // 统计
    await expect(page.locator('[data-rating-value]')).toHaveText('4.5');
    await expect(page.locator('[data-rating-sub]')).toHaveText('2 条评价');
    await expect(page.locator('[data-downloads-total]')).toHaveText('15');
    await expect(page.locator('[data-downloads-detail]')).toHaveText('共 15 次（Windows 12，网页版 3）');
    await page.locator('[data-reviews]').scrollIntoViewIfNeeded(); // 评价区接近视口才加载
    await expect(page.locator('[data-reviews-avg]')).toHaveText('4.5');
    await expect(page.locator('[data-bar-n="5"]')).toHaveText('1');
    await expect(page.locator('[data-bar-n="1"]')).toHaveText('0');
    // 第三方开发者 + 免费 → offers price 0
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const app = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'SoftwareApplication');
    expect(app.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'CNY' });
    expect(app.author).toMatchObject({ '@type': 'Organization', name: 'E2E Bot' });
  });

  test('数据库不可达：页面照常可读，评价区进入只读提示', async ({ page }) => {
    await mockSupabase(page, 'down');
    await page.goto('/apps/fablemotion/');
    await page.locator('[data-reviews]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-reviews]')).toHaveAttribute('data-state', 'offline');
    await expect(page.locator('[data-reviews] [data-status]')).toContainText('只读');
    await expect(page.locator('[data-rating-value]')).toHaveText('—');
  });
});

test.describe('应用目录', () => {
  test('静态分页：第 1 页 6 个，第 2 页其余；分页链接可用', async ({ page }) => {
    await page.goto('/apps/');
    await expect(page.locator('h1')).toHaveText('应用');
    await expect(cards(page)).toHaveCount(6);
    await expect(page.locator('[data-catalog-status]')).toContainText('第 1 / 2 页');
    await page.locator('[data-catalog-pages]').getByRole('link', { name: '下一页' }).click();
    await expect(page).toHaveURL(/\/apps\/page\/2\/$/);
    await expect(cards(page)).toHaveCount(3);
    await expect(page.locator('[data-catalog-pages] [aria-current="page"]')).toHaveText('2');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://azsou.com/apps/page/2/',
    );
  });

  test('按平台 / 分类 / 价格筛选，状态写进地址，刷新后恢复', async ({ page }) => {
    await page.goto('/apps/');
    await catalogReady(page);
    await page.getByLabel('平台', { exact: true }).selectOption('cli');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Sub2API');
    await expect(page).toHaveURL(/\/apps\/\?platform=cli$/);
    await expect(page.locator('[data-catalog-pages]')).toBeHidden();
    await page.getByLabel('平台', { exact: true }).selectOption('');
    await page.getByLabel('分类', { exact: true }).selectOption('browser-tools');
    await expect(cards(page)).toHaveCount(2);
    expect((await titles(page)).sort()).toEqual(['Capture Kit', 'Image Atlas Pro']);
    // 自研应用默认都是免费：价格筛选保留这两个；再叠加「命令行」平台就没有结果
    await page.getByLabel('价格', { exact: true }).selectOption('free');
    await expect(cards(page)).toHaveCount(2);
    await page.getByLabel('平台', { exact: true }).selectOption('cli');
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator('[data-catalog-grid]')).toContainText('没有符合条件的应用');
    await page.getByLabel('平台', { exact: true }).selectOption('');
    await page.getByLabel('价格', { exact: true }).selectOption('');
    await page.reload();
    await catalogReady(page);
    await expect(page.getByLabel('分类', { exact: true })).toHaveValue('browser-tools');
    await expect(cards(page)).toHaveCount(2);
    // 回到默认：恢复静态第 1 页
    await page.getByLabel('分类', { exact: true }).selectOption('');
    await expect(cards(page)).toHaveCount(6);
    await expect(page).toHaveURL(/\/apps\/$/);
  });

  test('排序：热门 = 真实下载数，评分 = 真实平均分；卡片显示统计', async ({ page }) => {
    await mockStats(
      page,
      [
        { app: 'sub2api', platform: 'cli', downloads: 40 },
        { app: 'hermes', platform: 'web', downloads: 25 },
        { app: 'hermes', platform: 'web', downloads: 1 },
      ],
      [
        { app: 'capture-kit', reviews: 3, average: 4.67 },
        { app: 'skill-tree-tool', reviews: 1, average: 5 },
      ],
    );
    await page.goto('/apps/');
    await catalogReady(page);
    await page.getByRole('button', { name: '热门' }).click();
    await expect(page.getByRole('button', { name: '热门' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/sort=hot/);
    await expect(cards(page).nth(0)).toContainText('Sub2API');
    await expect(cards(page).nth(1)).toContainText('Hermes');
    await expect(cards(page).nth(1).locator('[data-card-stats]')).toHaveText('暂无评分 · 下载 26 次');
    await page.getByRole('button', { name: '评分' }).click();
    await expect(cards(page).nth(0)).toContainText('职业技能树工具');
    await expect(cards(page).nth(1)).toContainText('Capture Kit');
    await expect(cards(page).nth(1).locator('[data-card-stats]')).toHaveText('★ 4.7（3 条评价）');
    await expect(page.locator('[data-catalog-status]')).toContainText('按评分排序');
    // 结果分页（客户端）
    await page.locator('[data-catalog-pages]').getByRole('button', { name: '第 2 页' }).click();
    await expect(cards(page)).toHaveCount(3);
    await expect(page).toHaveURL(/sort=rating&page=2/);
  });

  test('统计不可用时热门 / 评分退回最新并提示', async ({ page }) => {
    await mockSupabase(page, 'down');
    await page.goto('/apps/?sort=hot');
    await catalogReady(page);
    await expect(page.locator('[data-catalog-status]')).toContainText('统计数据暂时不可用，已按最新排序');
    await expect(cards(page)).toHaveCount(6);
  });

  test('分类页与平台页', async ({ page }) => {
    await page.goto('/apps/category/ai/');
    await expect(page.locator('h1')).toHaveText('AI 工具');
    expect((await titles(page)).sort()).toEqual(['Sub2API', '程序化声场']);
    await expect(page.getByLabel('分类', { exact: true })).toBeDisabled();
    await expect(page.locator('.chip[aria-current="page"]')).toContainText('AI 工具');
    await page.goto('/apps/platform/browser-ext/');
    await expect(page.locator('h1')).toHaveText('浏览器扩展应用');
    expect((await titles(page)).sort()).toEqual(['Capture Kit', 'Image Atlas Pro']);
    // 平台页上再按价格筛选，地址不重复写固定的平台
    await catalogReady(page);
    await page.getByRole('button', { name: '热门' }).click();
    await expect(page).toHaveURL(/\/apps\/platform\/browser-ext\/\?sort=hot$/);
  });
});

test.describe('下载中转 /go/', () => {
  test('外链提示、SHA-256、点击后先计数再跳转', async ({ page, errors }) => {
    const calls: unknown[] = [];
    await page.route('**/rest/v1/rpc/app_count_download', (route) => {
      calls.push(route.request().postDataJSON());
      return json(route, 42);
    });
    await page.route('https://example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>example</title><h1>download</h1>',
      }),
    );
    await page.goto('/go/e2e-fixture/windows/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('h1')).toHaveText('E2E 夹具应用');
    await expect(page.locator('[role="note"]')).toContainText('example.com');
    await expect(page.locator('[data-sha]')).toHaveText(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    await expect(page.locator('[data-go-count]')).toHaveText('0 次');
    await expect(page.locator('[data-go-page]')).toHaveAttribute('data-ready', 'yes');
    const go = page.getByRole('link', { name: '继续前往 example.com' });
    await expect(go).toHaveAttribute('rel', 'nofollow noopener');
    await go.click();
    await page.waitForURL('https://example.com/downloads/e2e-fixture-1.0.0.zip');
    expect(calls).toEqual([{ p_app: 'e2e-fixture', p_platform: 'windows' }]);
    expect(errors).toEqual([]);
  });

  test('计数服务不可达时照常跳转（下载不受影响）', async ({ page }) => {
    await mockSupabase(page, 'down');
    await page.route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>example</title>' }),
    );
    await page.goto('/go/e2e-fixture/web/');
    await expect(page.locator('[data-go-page]')).toHaveAttribute('data-ready', 'yes');
    await page.getByRole('link', { name: /继续前往/ }).click();
    await page.waitForURL('https://example.com/e2e-web/');
  });

  test('没有下载地址的平台：说明暂未提供，没有外链；自研应用「即将推出」的平台说明上线通知', async ({
    page,
  }) => {
    await page.goto('/go/e2e-fixture/android/');
    await expect(page.locator('[role="note"]')).toContainText('暂未提供');
    await expect(page.locator('[data-go]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '返回应用页' })).toHaveAttribute(
      'href',
      '/apps/e2e-fixture/',
    );
    await page.goto('/go/fablemotion/windows/');
    await expect(page.locator('[role="note"]')).toContainText('即将推出');
    await expect(page.locator('[data-go]')).toHaveCount(0);
  });

  test('/go/ 不进 sitemap，robots 禁止抓取', async ({ request }) => {
    const sm = await (await request.get('/sitemap-0.xml')).text();
    expect(sm).not.toContain('/go/');
    expect(sm).toContain('https://azsou.com/apps/category/ai/');
    expect(sm).toContain('https://azsou.com/apps/page/2/');
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /go/');
  });
});
