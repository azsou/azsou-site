import { expect, test } from '@playwright/test';
import { mockAdmin, type AdminMockState } from './admin-mock';
import { settle } from './detect';
import { FIXED_TIME } from './pages';

const CASES: { name: string; width: number; theme: 'light' | 'dark'; state: AdminMockState }[] = [
  { name: 'data-light-390', width: 390, theme: 'light', state: 'data' },
  { name: 'data-dark-390', width: 390, theme: 'dark', state: 'data' },
  { name: 'empty-light-390', width: 390, theme: 'light', state: 'empty' },
  { name: 'error-light-390', width: 390, theme: 'light', state: 'error' },
  { name: 'data-light-320', width: 320, theme: 'light', state: 'data' },
  { name: 'data-light-360', width: 360, theme: 'light', state: 'data' },
  { name: 'data-light-600', width: 600, theme: 'light', state: 'data' },
  { name: 'data-light-1440', width: 1440, theme: 'light', state: 'data' },
];

for (const c of CASES) {
  test(`content tools ${c.name}`, async ({ page }) => {
    await page.setViewportSize({ width: c.width, height: c.width >= 900 ? 900 : 844 });
    await page.emulateMedia({ colorScheme: c.theme, reducedMotion: 'reduce' });
    await mockAdmin(page, { state: c.state });
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    await page.goto(c.state === 'empty' ? '/admin/content/?q=nothing' : '/admin/content/', {
      waitUntil: 'networkidle',
    });
    await expect(page.locator('[data-admin-body]')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await settle(page);

    const tools = page.getByRole('group', { name: '表格工具', exact: true });
    const density = tools.getByRole('group', { name: '表格密度', exact: true });
    const standard = density.getByRole('button', { name: '标准', exact: true });
    const compact = density.getByRole('button', { name: '紧凑', exact: true });
    const sort = tools.getByRole('combobox', { name: '排序', exact: true });
    const all = tools.getByRole('checkbox', { name: '全选本页', exact: true });
    const allHit = tools.locator('label.check:has(input[data-select-all])');
    const columns = tools.getByRole('button', { name: '列', exact: true });
    const views = tools.getByRole('button', { name: '视图', exact: true });
    const csv = tools.getByRole('button', { name: '导出本页 CSV', exact: true });
    await expect(tools).toBeVisible();
    await expect(all).toBeVisible();
    if (c.width < 900) await expect(sort).toBeVisible();
    else await expect(sort).toBeHidden();

    const controls = [standard, compact, ...(c.width < 900 ? [sort] : []), allHit, columns, views, csv];
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Missing visible toolbar control bounds');
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(c.width + 1);
      if (c.width < 600) {
        expect(box.width, '手机点击区宽度').toBeGreaterThanOrEqual(44);
        expect(box.height, '手机点击区高度').toBeGreaterThanOrEqual(44);
      }
      boxes.push(box);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        expect(overlapX * overlapY, '工具栏点击区不能重叠').toBeLessThanOrEqual(1);
      }
    }
    const overflow = await page.evaluate(
      () =>
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        document.documentElement.clientWidth,
    );
    expect(overflow, '页面不能横向溢出').toBeLessThanOrEqual(1);

    if (c.width === 390) {
      const rowCenters: number[] = [];
      for (const box of boxes) {
        const center = box.y + box.height / 2;
        if (!rowCenters.some((y) => Math.abs(y - center) <= 2)) rowCenters.push(center);
      }
      expect(rowCenters.length, '390px 工具栏应为两行').toBe(2);
      const box = await tools.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Missing toolbar bounds');
      expect(box.height, '两行工具栏总高').toBeLessThanOrEqual(104);
    }

    // 真正按 Tab 走过所有入口；不隐藏排序，也不通过 CSS order 改变阅读顺序。
    if (c.width === 390 && c.state === 'data') {
      await standard.focus();
      await expect(standard).toBeFocused();
      for (const control of [compact, sort, all, columns, views, csv]) {
        await page.keyboard.press('Tab');
        await expect(control).toBeFocused();
      }
      await sort.selectOption('2:ascending');
      await expect(page.locator('th[data-sort-key="title"]')).toHaveAttribute('aria-sort', 'ascending');
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await sort.selectOption('2:descending');
      await expect(page.locator('th[data-sort-key="title"]')).toHaveAttribute('aria-sort', 'descending');
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await sort.selectOption('');
      await expect(page.locator('th[aria-sort]')).toHaveCount(0);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      for (const button of [columns, views]) {
        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(button).toHaveAttribute('aria-expanded', 'false');
        await expect(button).toBeFocused();
      }
    }
  });
}
