import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

/**
 * T6.8 首页（应用商店 + 内容门户）：区块按真实数据渲染、没有数据的区块整块隐藏、横向行的上一组 / 下一组按钮、
 * hero 搜索与 Ctrl/⌘K、站内链接全部可用、移动端底部 TabBar 不遮挡内容、结构化数据、不出现伪造指标。
 */

const EXPECTED = [
  'featured',
  'apps',
  'ai',
  'updates',
  'categories',
  'videos',
  'games',
  'articles',
  'works',
  'forum',
];
const isDesktop = (name: string) => name.endsWith('-desktop');
const sections = (page: Page) =>
  page
    .locator('main section[data-section]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));

test.describe('首页 /', () => {
  test('区块按顺序渲染、每块都有真实条目；没有数据的「最新上架」整块隐藏', async ({ page, errors }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('一站找到');
    expect(await sections(page)).toEqual([...EXPECTED, 'about', 'rss']);
    // 应用都没有 releaseDate → 不渲染「最新上架」，也没有空壳 / 占位框
    await expect(page.locator('[data-section="new"]')).toHaveCount(0);
    for (const id of EXPECTED) {
      const items = page.locator(`[data-section="${id}"] :is(li, article)`);
      expect(await items.count(), id).toBeGreaterThan(0);
    }
    // 不伪造评分 / 下载量 / 用户数，没有广告位
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text).not.toMatch(/★|评分\s*\d|\d+(\.\d+)?\s*(万|千)?\s*次下载|下载量\s*\d|\d+\s*位用户|广告/);
    await expect(page.locator('[data-section="ai"] .home-sec__note')).toContainText('按编辑推荐顺序');
    expect(errors).toEqual([]);
  });

  test('编辑精选 = featured 的自研应用 + AI 工具，与 ItemList 结构化数据一致', async ({ page }) => {
    await page.goto('/');
    const slugs = await page
      .locator('[data-section="featured"] [data-featured]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-featured')));
    expect(slugs[0]).toBe('fablemotion');
    expect(slugs).toEqual(expect.arrayContaining(['claude-code', 'codex-cli', 'cursor']));
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const list = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'ItemList');
    expect(list.numberOfItems).toBe(slugs.length);
    expect(list.itemListElement[0].url).toBe('https://azsou.com/apps/fablemotion/');
    const site = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'WebSite');
    expect(site.potentialAction.target.urlTemplate).toContain('/search/?q=');
    expect(ld['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(
      expect.arrayContaining(['Organization', 'Person']),
    );
  });

  test('hero 搜索提交到 /search/；快捷入口带真实数量', async ({ page }) => {
    await page.goto('/');
    const input = page.getByRole('search', { name: '站内搜索' }).getByLabel('搜索关键词');
    await input.fill('塔防');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/search\/\?q=%E5%A1%94%E9%98%B2$/);
    await expect(page.locator('[data-results] a').first()).toContainText('声波塔防');

    await page.goto('/');
    const chips = page.locator('.home-chips a');
    expect(await chips.count()).toBeGreaterThan(3);
    await expect(page.locator('.home-chips a[href="/ai/category/mcp/"]')).toContainText(/MCP\D*\d+/);
    await expect(page.locator('.home-chips a[href="/apps/platform/browser-ext/"]')).toBeVisible();
  });

  test('Ctrl/⌘K 打开全站搜索面板（首页同样适用）', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '键盘快捷键只在桌面验证');
    await page.goto('/');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await expect(page.getByRole('combobox', { name: '搜索关键词' })).toBeFocused();
  });

  test('横向行：上一组 / 下一组按钮（到头禁用、可键盘操作、有无障碍名称）', async ({ page }, info) => {
    test.skip(!isDesktop(info.project.name), '按钮只在 ≥ 768px 显示；窄屏用手势滑动');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const sec = page.locator('[data-section="ai"]');
    const track = sec.locator('[data-srow]');
    const prev = sec.getByRole('button', { name: '上一组：AI 工具' });
    const next = sec.getByRole('button', { name: '下一组：AI 工具' });
    await expect(next).toBeVisible();
    await expect(next).toHaveAttribute('aria-controls', 'row-ai');
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => track.evaluate((e) => e.scrollLeft)).toBeGreaterThan(100);
    await expect(prev).toBeEnabled();
    // 键盘：Tab 到按钮、Enter 触发
    await prev.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => track.evaluate((e) => e.scrollLeft)).toBeLessThan(3);
    await expect(prev).toBeDisabled();
    // 滚到尾：下一组禁用、上一组可用（按钮状态在 scroll 事件后的下一帧更新，所以等状态而不是连点）
    await track.evaluate((e) => e.scrollTo({ left: e.scrollWidth, behavior: 'instant' }));
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    // 滚动区域可聚焦（键盘用户能用方向键滚动）
    await expect(track).toHaveAttribute('tabindex', '0');
    await expect(track).toHaveAttribute('aria-label', 'AI 工具');
  });

  test('窄屏：按钮隐藏，行可横向滑动且不撑宽页面', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, '只看 < 768px（平板及以上显示按钮）');
    await page.goto('/');
    await expect(page.locator('[data-section="featured"] .srow-ctl')).toBeHidden();
    const track = page.locator('#row-featured');
    expect(await track.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    // 失败时列出撑宽页面的元素（不在横向滚动容器里、右边超出视口的）
    const culprits = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .filter((e) => !e.parentElement?.closest('.srow, .home-chips ul, .tabbar'))
        .slice(0, 5)
        .map(
          (e) => `${e.tagName.toLowerCase()}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`,
        ),
    );
    expect(overflow, culprits.join(' | ')).toBeLessThanOrEqual(1);
  });

  test('移动端：底部 TabBar 不遮挡最后的内容', async ({ page }, info) => {
    test.skip(isDesktop(info.project.name) || info.project.name.endsWith('-tablet'), '只在手机视口');
    await page.goto('/');
    const tabbar = page.locator('.tabbar');
    await expect(tabbar).toBeVisible();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const tabTop = await tabbar.evaluate((e) => e.getBoundingClientRect().top);
    for (const sel of ['[data-section="rss"] .btn-row', '.site-footer .footer-bottom']) {
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
    expect(hrefs.length).toBeGreaterThan(60);
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
