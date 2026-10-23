import { test, expect } from './fixtures';
import { ROUTES } from './routes';

/** 每个路由 × 每个浏览器/视口：能打开、结构与 SEO 完整、无横向溢出、图片可用、无脚本错误 */
for (const route of ROUTES) {
  test(`page ${route}`, async ({ page, errors }) => {
    const res = await page.goto(route, { waitUntil: 'load' });
    expect(res?.status(), 'HTTP 状态').toBe(200);
    await expect(page).toHaveTitle(/AZ Studio/);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    const desc = await page.locator('meta[name="description"]').getAttribute('content');
    expect(desc && desc.length, 'meta description').toBeGreaterThan(8);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/^https:\/\/azsou\.com\//);
    if (route !== '/404.html') expect(canonical).toBe(`https://azsou.com${route}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https:\/\/azsou\.com\/.+\.png$/);
    const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(() => JSON.parse(ld!)).not.toThrow();
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('header.site-nav')).toBeVisible();
    // 不允许横向滚动
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '横向溢出像素').toBeLessThanOrEqual(1);
    // 图片都有 alt；首屏（eager）图片必须加载成功
    const broken = await page.evaluate(async () => {
      const imgs = [...document.images];
      await Promise.all(
        imgs.map((i) =>
          i.complete
            ? null
            : new Promise((r) => {
                i.onload = i.onerror = r;
                setTimeout(r, 3000);
              }),
        ),
      );
      return imgs.filter((i) => !i.getAttribute('alt') || (i.loading !== 'lazy' && i.naturalWidth === 0)).map((i) => i.src);
    });
    expect(broken, '缺 alt 或加载失败的图片').toEqual([]);
    await page.waitForLoadState('networkidle');
    expect(errors, '控制台错误').toEqual([]);
  });
}
