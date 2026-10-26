import { expect, test } from '@playwright/test';
import { FIXED_TIME } from './pages';
import { settle } from './detect';

/**
 * P10 密度门禁（T10.6 验收 / T10.24 雏形）：首页首屏可点的商店条目数下限、区块间距上限、条目图标尺寸白名单。
 * 「可点条目」= main 里的 [data-entry]（应用 / AI 工具 / 游戏条目，整张可点），顶边在首屏内且在视口宽度内（横滑露出的也算）。
 */
const CASES = [
  { name: '1440', width: 1440, height: 900, min: 12 },
  { name: '390', width: 390, height: 844, min: 6 },
] as const;
/** 区块间距上限（px）：紧凑档 40 / 手机 32（DESIGN-SYSTEM P10、tokens density） */
const GAP_MAX = 40;
/** 条目图标尺寸白名单：排行 40、列表行 56、格子 72 */
const ICON_SIZES = [40, 56, 72];

for (const c of CASES) {
  test(`首页首屏可点条目 ≥ ${c.min} @${c.name}`, async ({ page }) => {
    await page.setViewportSize({ width: c.width, height: c.height });
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    await page.goto('/', { waitUntil: 'networkidle' });
    await settle(page);
    const m = await page.evaluate(() => {
      const vh = innerHeight;
      // 手机底部 TabBar 盖住的部分不算首屏
      const tab = document.querySelector('.tabbar');
      const fold = tab && getComputedStyle(tab).display !== 'none' ? tab.getBoundingClientRect().top : vh;
      const entries = [...document.querySelectorAll<HTMLElement>('main [data-entry]')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < fold - 24 && r.left < innerWidth - 24 && r.right > 0;
      });
      const secs = [...document.querySelectorAll<HTMLElement>('main section[data-section]')];
      const gaps = secs
        .slice(1)
        .map((s, i) => Math.round(s.getBoundingClientRect().top - secs[i].getBoundingClientRect().bottom));
      const icons = [...document.querySelectorAll<HTMLElement>('main [data-entry] .entry__icon > *')]
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => Math.round(e.getBoundingClientRect().width));
      const head = document.querySelector('.store-head')!.getBoundingClientRect().height;
      return { entries: entries.length, gaps, icons: [...new Set(icons)], head };
    });
    expect(m.entries, '首屏可点条目').toBeGreaterThanOrEqual(c.min);
    expect(Math.max(...m.gaps), `区块间距 ${m.gaps.join(' ')}`).toBeLessThanOrEqual(GAP_MAX);
    expect(
      m.icons.filter((s) => !ICON_SIZES.includes(s)),
      '条目图标尺寸',
    ).toEqual([]);
    expect(m.head, '搜索头高度（含热门词）').toBeLessThanOrEqual(160);
  });
}

test('列表页 /apps/ 1440：分类栏在左侧、工具条有结果数 / 排序 / 显示方式', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/apps/', { waitUntil: 'networkidle' });
  const rail = page.locator('.list-rail');
  const main = page.locator('.list-main');
  const [r, mm] = [await rail.boundingBox(), await main.boundingBox()];
  expect(r!.x + r!.width).toBeLessThanOrEqual(mm!.x);
  await expect(page.locator('.list-toolbar [role="status"]')).toContainText(/共 \d+ 个应用/);
  await expect(page.getByRole('group', { name: '排序' })).toBeVisible();
  await expect(page.getByRole('group', { name: '显示方式' })).toBeVisible();
});
