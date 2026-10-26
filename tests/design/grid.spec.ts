/**
 * Q9 布局（DESIGN-SYSTEM §8，T9.8）：统一栅格的列数按断点表、同一行卡片等高（差 ≤ 1px）、中英列表列数一致；
 * 悬停不引起布局位移（CLS 0）。
 */
import { expect, test } from '@playwright/test';

/** 断点 → 列数：媒体卡 / 行卡（≥ 1600 各 +1 列）/ 商店格子（P10 T10.8 列表页，≥ 1200 有左侧分类栏） */
const COLS = [
  { w: 390, media: 1, row: 1, tile: 2 },
  { w: 768, media: 2, row: 2, tile: 4 },
  { w: 1024, media: 3, row: 2, tile: 5 },
  { w: 1440, media: 4, row: 3, tile: 5 },
  { w: 1920, media: 5, row: 4, tile: 6 },
];
const PAGES = [
  { name: 'apps', path: '/apps/' },
  { name: 'en-apps', path: '/en/apps/' },
  { name: 'games', path: '/games/' },
  { name: 'articles', path: '/articles/' },
  { name: 'videos', path: '/videos/' },
];

for (const p of PAGES) {
  for (const c of COLS) {
    test(`栅格列数与等高 ${p.name} @${c.w}`, async ({ page }) => {
      await page.setViewportSize({ width: c.w, height: 900 });
      await page.goto(p.path);
      const grids = await page.$$eval('main [data-grid]', (els) =>
        els
          .filter((g) => g.getBoundingClientRect().width > 0)
          .map((g) => {
            const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
            const kids = Array.from(g.children).filter((k) => (k as HTMLElement).offsetParent !== null);
            const rows = new Map<number, number[]>();
            for (const k of kids) {
              const r = k.getBoundingClientRect();
              const top = Math.round(r.top);
              rows.set(top, [...(rows.get(top) ?? []), r.height]);
            }
            const spread = Math.max(0, ...[...rows.values()].map((hs) => Math.max(...hs) - Math.min(...hs)));
            return { kind: g.getAttribute('data-grid'), cols, n: kids.length, spread };
          }),
      );
      expect(grids.length, '页面上至少一个统一栅格').toBeGreaterThan(0);
      for (const g of grids) {
        const want = g.kind === 'row' ? c.row : g.kind === 'tile' ? c.tile : c.media;
        expect(g.cols, `${g.kind} 栅格列数`).toBe(want);
        expect(g.spread, `${g.kind} 栅格同一行高度差`).toBeLessThanOrEqual(1);
      }
    });
  }
}

test('悬停卡片不引起布局位移', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/apps/');
  const card = page.locator('main [data-grid] .card__link').first();
  const before = await page.locator('main [data-grid] > *').nth(1).boundingBox();
  await card.hover();
  await page.waitForTimeout(400);
  const after = await page.locator('main [data-grid] > *').nth(1).boundingBox();
  expect(after).toEqual(before);
});
