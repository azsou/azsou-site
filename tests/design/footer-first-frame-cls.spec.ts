import { expect, test, type Page } from '@playwright/test';
import { isSupabaseOrThirdParty } from '../supabase-route';
import { EN_FOOTER } from '../../src/lib/i18n-labels';
import { FOOTER } from '../../src/lib/site';

/**
 * 回归：HTML 只解析到页脚一半时先画的那一帧，已解析出来的页脚列必须已在最终位置。
 *
 * 根因（2026-10-28，CI push 40684230597 lighthouse desktop /login/ CLS 0.0214 > 0.02，元素
 * footer.site-footer > div.shell > div.footer-grid > div「发现」列）：.footer-grid 原为
 * repeat(auto-fit, minmax(…180px, 1fr))。auto-fit 折叠空轨道，只解析出前两列时第 2 列被拉宽、x 右移；
 * 后两列到齐后跳回。/login/ 页短，页脚 top≈812 落在 1350×940 首屏内，于是计入 CLS；长页面页脚在首屏外不计。
 * 同一 SHA 的 PR 运行 40684235625 该页为 0（是否画出那一帧取决于时序），所以这里不靠时序：
 * 直接把 HTML 截断在第 1 / 2 / 3 列之后，由浏览器补齐标签，关掉 JS，只比 CSS 布局。
 */
test.use({ javaScriptEnabled: false });

test.beforeEach(async ({ page }) => {
  await page.route(isSupabaseOrThirdParty, (r) => r.abort());
});

test('页脚列数 = 4（global.css .footer-grid 的「最多 4 列」下限按这个写）', () => {
  expect(FOOTER.length + 1).toBe(4);
  expect(EN_FOOTER.length + 1).toBe(4);
});

const columns = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.footer-grid > div')].map((d) => {
      const r = d.getBoundingClientRect();
      return {
        x: Math.round(r.left * 10) / 10,
        y: Math.round((r.top + scrollY) * 10) / 10,
        w: Math.round(r.width * 10) / 10,
      };
    }),
  );

/** 截断点：第 k 列之后（下一列的起始 <div 之前）。 */
function cutPoints(html: string): number[] {
  const grid = html.indexOf('class="footer-grid');
  expect(grid, '找不到 .footer-grid').toBeGreaterThan(0);
  const cuts: number[] = [];
  let from = grid;
  for (;;) {
    const h2 = html.indexOf('<h2', from);
    const bottom = html.indexOf('class="footer-bottom', grid);
    if (h2 < 0 || (bottom > 0 && h2 > bottom)) break;
    cuts.push(html.lastIndexOf('<div', h2));
    from = h2 + 3;
  }
  return cuts;
}

for (const path of ['/login/', '/en/', '/']) {
  for (const width of [1350, 1440, 1024, 390]) {
    test(`首帧 CLS ${path} @${width}：页脚只解析出前几列时，已有列已在最终位置`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 940 });
      const url = new URL(path, baseURL).href;
      const html = await (await page.request.get(url)).text();
      await page.goto(path, { waitUntil: 'load' });
      const full = await columns(page);
      expect(full.length, '完整页面：页脚 4 列').toBe(4);
      const cuts = cutPoints(html);
      expect(cuts.length, '截断点：第 2 / 3 / 4 列之前').toBe(3);

      for (const [i, cut] of cuts.entries()) {
        await page.route(url, (r) =>
          r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html.slice(0, cut) }),
        );
        await page.goto(path, { waitUntil: 'load' });
        const partial = await columns(page);
        await page.unroute(url);
        expect(partial.length, `解析到第 ${i + 1} 列`).toBe(i + 1);
        partial.forEach((c, k) => {
          expect({ x: c.x, y: c.y }, `解析到第 ${i + 1} 列：第 ${k + 1} 列位置`).toEqual({
            x: full[k].x,
            y: full[k].y,
          });
        });
      }
    });
  }
}
