import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

/**
 * P10 T10.6 首页（纯货架）：紧凑搜索头 → 货架（最新更新 / AI 工具编辑推荐排行 / 我们的应用 / 游戏 / 按平台 / 分类）
 * → 文章、视频各一行。货架按真实数据渲染、不出现评分 / 下载量等伪造指标；搜索与 Ctrl/⌘K；
 * 窄屏货架横滑不撑宽页面；站内链接全部可用；移动端底部 TabBar 不遮挡内容；结构化数据。
 */

const EXPECTED = [
  'latest',
  'ai',
  'featured',
  'apps',
  'games',
  'platforms',
  'categories',
  'articles',
  'videos',
];
const isDesktop = (name: string) => name.endsWith('-desktop');
const sections = (page: Page) =>
  page
    .locator('main section[data-section]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));

test.describe('首页 /', () => {
  test('货架按顺序渲染、每块都有真实条目；没有 hero 装饰与大 CTA；不显示评分 / 下载量', async ({
    page,
    errors,
  }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('应用、AI 工具与游戏');
    expect(await sections(page)).toEqual(EXPECTED);
    // T10.7：装饰图标拼贴、平台胶囊区、大 CTA 区已删除
    await expect(page.locator('.icon-wall, .home-chips, .home-cta, .home-hero')).toHaveCount(0);
    for (const id of EXPECTED) {
      const items = page.locator(`[data-section="${id}"] li`);
      expect(await items.count(), id).toBeGreaterThan(0);
    }
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text).not.toMatch(
      /★|评分\s*\d|\d+(\.\d+)?\s*(万|千)?\s*次下载|下载量\s*\d|\d+\s*位用户|广告|N\/A/,
    );
    // 排行如实标注编辑推荐，名次 1–10
    await expect(page.locator('[data-section="ai"] .shelf__note')).toContainText('按编辑推荐');
    await expect(page.locator('[data-section="ai"] [data-entry]')).toHaveCount(10);
    // 每个商店条目都有类型徽标与主操作
    const entries = page.locator('[data-section="latest"] [data-entry]');
    expect(await entries.count()).toBeGreaterThanOrEqual(12);
    await expect(entries.first().locator('.entry__type')).toHaveText(/应用|AI 工具|游戏/);
    await expect(entries.first().locator('.entry__action')).toHaveAttribute(
      'href',
      /^\/(apps|ai|games|go)\//,
    );
    expect(errors).toEqual([]);
  });

  test('最新更新 = 有更新日期的条目（新的在前），与 ItemList 结构化数据一致', async ({ page }) => {
    await page.goto('/');
    const slugs = await page
      .locator('[data-section="latest"] [data-entry]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-entry')));
    const dates = await page
      .locator('[data-section="latest"] [data-entry]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-sort-new') ?? ''));
    expect(dates.every(Boolean)).toBe(true);
    expect([...dates].sort().reverse()).toEqual(dates);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const list = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'ItemList');
    expect(list.numberOfItems).toBe(slugs.length);
    expect(list.itemListElement[0].url).toMatch(/^https:\/\/azsou\.com\/(apps|games)\//);
    const site = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'WebSite');
    expect(site.potentialAction.target.urlTemplate).toContain('/search/?q=');
    expect(ld['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(
      expect.arrayContaining(['Organization', 'Person']),
    );
  });

  test('搜索头提交到 /search/；推荐搜索词；按平台入口带真实数量', async ({ page }) => {
    await page.goto('/');
    const input = page.getByRole('search', { name: '站内搜索' }).getByLabel('搜索关键词');
    await input.fill('塔防');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/search\/\?q=%E5%A1%94%E9%98%B2$/);
    await expect(page.locator('[data-results] a').first()).toContainText('声波塔防');

    await page.goto('/');
    await expect(page.locator('.home-try a')).toHaveCount(4);
    await expect(
      page.locator('[data-section="platforms"] a[href="/apps/platform/browser-ext/"]'),
    ).toBeAttached();
    await expect(page.locator('[data-section="platforms"] .gate').first()).toContainText(/\d+ 个应用/);
  });

  test('Ctrl/⌘K 打开全站搜索面板（首页同样适用）', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '键盘快捷键只在桌面验证');
    await page.goto('/');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await expect(page.getByRole('combobox', { name: '搜索关键词' })).toBeFocused();
  });

  test('窄屏：货架横向滑动、可聚焦，不撑宽页面', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 900, '只看 < 900px（宽屏是 2 行网格）');
    await page.goto('/');
    const track = page.locator('[data-section="latest"] [data-shelf]');
    expect(await track.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    await expect(track).toHaveAttribute('tabindex', '0');
    await expect(track).toHaveAttribute('aria-label', '最新更新');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const culprits = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .filter((e) => !e.parentElement?.closest('[data-shelf], .home-try, .tabbar'))
        .slice(0, 5)
        .map(
          (e) => `${e.tagName.toLowerCase()}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`,
        ),
    );
    expect(overflow, culprits.join(' | ')).toBeLessThanOrEqual(1);
  });

  test('宽屏：货架是 2 行网格（多出的条目隐藏，去「更多」看全部）', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 1200, '只看 ≥ 1200');
    await page.goto('/');
    const tops = await page
      .locator('[data-section="latest"] [data-entry]')
      .evaluateAll((els) =>
        els
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => Math.round(e.getBoundingClientRect().top)),
      );
    expect(new Set(tops).size).toBe(2);
  });

  test('移动端：底部 TabBar 不遮挡最后的内容', async ({ page }, info) => {
    test.skip(isDesktop(info.project.name) || info.project.name.endsWith('-tablet'), '只在手机视口');
    await page.goto('/');
    const tabbar = page.locator('.tabbar');
    await expect(tabbar).toBeVisible();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const tabTop = await tabbar.evaluate((e) => e.getBoundingClientRect().top);
    for (const sel of ['[data-section="videos"] [data-shelf]', '.site-footer .footer-bottom']) {
      const bottom = await page.locator(sel).evaluate((e) => e.getBoundingClientRect().bottom);
      expect(bottom, sel).toBeLessThanOrEqual(tabTop + 1);
    }
  });

  test('首页所有站内链接都可访问（200）', async ({ page, request }, info) => {
    test.skip(!/chromium-desktop/.test(info.project.name), '链接检查与引擎 / 视口无关，只跑一次');
    await page.goto('/');
    const hrefs = await page
      .locator('main a[href^="/"]')
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')!))]);
    // P10 纯货架：条目 + 主操作 + 平台 / 分类入口，站内链接 60 以上
    expect(hrefs.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const h of hrefs) {
      const r = await request.get(h);
      if (r.status() !== 200) bad.push(`${h} → ${r.status()}`);
    }
    expect(bad).toEqual([]);
  });

  test('图片：全部有 alt、懒加载、只用本站资源；首页不向视频平台发请求', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.resourceType() === 'image' && u.hostname !== '127.0.0.1') external.push(r.url());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const imgs = await page.locator('main img').evaluateAll((els) =>
      els.map((e) => ({
        alt: e.getAttribute('alt'),
        loading: e.getAttribute('loading'),
        src: e.getAttribute('src') ?? '',
        w: e.getAttribute('width'),
        h: e.getAttribute('height'),
      })),
    );
    expect(imgs.length).toBeGreaterThan(20);
    for (const i of imgs) {
      // alt="" = 名称就在旁边的装饰图标（T9.3）；首屏小图标 eager（T9.4），其余懒加载
      expect(i.alt, i.src).not.toBeNull();
      if (i.loading === 'eager') expect(i.src, i.src).toMatch(/\/icons\//);
      else expect(i.loading, i.src).toBe('lazy');
      expect(i.src.startsWith('/'), i.src).toBe(true);
      expect(i.w && i.h, i.src).toBeTruthy();
    }
    expect(external).toEqual([]);
  });

  test('暗色模式：无障碍（含对比度）检查通过', async ({ page }, info) => {
    test.skip(!/-(desktop|iphone)$/.test(info.project.name), '仅桌面与 iPhone 视口');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(
      r.violations.map(
        (v) =>
          `${v.id}: ${v.nodes
            .map((n) => n.target.join(' '))
            .slice(0, 3)
            .join(' | ')}`,
      ),
    ).toEqual([]);
  });
});
