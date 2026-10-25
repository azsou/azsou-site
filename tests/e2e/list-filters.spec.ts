import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * T9.12 列表页「单套筛选 + 更多筛选」：每个列表只有一套常驻筛选（分类标签或分段控件），
 * 次要条件收进「更多筛选」弹层；/games/、/works/ 的分段筛选只隐藏条目，状态写进查询串并可恢复。
 */

const ready = (page: Page) => expect(page.locator('[data-list-filter]')).toHaveAttribute('data-ready', 'yes');
const visibleIn = (page: Page, sel: string) => page.locator(`${sel}:not([hidden])`);

test.describe('列表页单套筛选（T9.12）', () => {
  test('/ai/、/videos/：常驻的只有分类标签，其余条件在收起的「更多筛选」里', async ({ page }) => {
    for (const path of ['/ai/', '/videos/']) {
      await page.goto(path);
      const bar = page.locator('.filter-bar');
      await expect(bar).toHaveCount(1);
      await expect(bar.locator('.chip-nav')).toBeVisible();
      const more = bar.locator('[data-more-filters]');
      await expect(more).not.toHaveAttribute('open', '');
      await expect(more.locator('.more-filters__body')).toBeHidden();
      // 页面上没有第二套常驻的筛选面板
      await expect(page.locator('main .panel[role="group"]')).toHaveCount(0);
      await more.locator('summary').click();
      await expect(more.locator('.more-filters__body')).toBeVisible();
      // 点外部收起
      await page.locator('h1').click();
      await expect(more).not.toHaveAttribute('open', '');
    }
  });

  test('/articles/：分段控件只放最常用的标签，其余标签在「更多筛选」里且链接到标签页', async ({ page }) => {
    await page.goto('/articles/');
    const seg = page.getByRole('navigation', { name: '按标签筛选' }).getByRole('link');
    await expect(seg).toHaveCount(5); // 全部 + 4 个
    await expect(seg.first()).toHaveAttribute('aria-current', 'page');
    const more = page.locator('[data-more-filters]');
    await more.locator('summary').click();
    const rest = page.getByRole('navigation', { name: '更多标签' }).getByRole('link');
    expect(await rest.count()).toBeGreaterThan(0);
    for (const href of await rest.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      expect(href).toMatch(/^\/tags\/[a-z0-9-]+\/$/);
    // 两组标签不重复
    const a = await seg.allTextContents();
    const b = (await rest.allTextContents()).map((t) => t.replace(/\s*\d+\s*$/, '').trim());
    for (const t of b) expect(a.map((x) => x.trim())).not.toContain(t);
  });

  test('/games/：按形态分段筛选，查询串可分享、刷新后恢复，未知值忽略', async ({ page, errors }) => {
    await page.goto('/games/');
    await ready(page);
    const cards = '[data-filter-item]';
    const total = await page.locator(cards).count();
    await expect(page.locator('[data-list-status]')).toHaveText(`共 ${total} 个游戏`);
    const group = page.getByRole('group', { name: '按形态筛选' });
    const second = group.getByRole('button').nth(1);
    const kind = (await second.textContent())!.trim();
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(
      new RegExp(`/games/\\?kind=${encodeURIComponent(kind).replace(/%20/g, '\\+')}$`),
    );
    const n = await visibleIn(page, cards).count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(total);
    for (const v of await visibleIn(page, cards).evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.filterValue),
    ))
      expect(v).toBe(kind);
    await expect(page.locator('[data-list-status]')).toHaveText(`共 ${n} 个游戏 · ${kind}`);
    await page.reload();
    await ready(page);
    await expect(group.getByRole('button', { name: kind, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(visibleIn(page, cards)).toHaveCount(n);
    await group.getByRole('button', { name: '全部', exact: true }).click();
    await expect(page).toHaveURL(/\/games\/$/);
    await expect(visibleIn(page, cards)).toHaveCount(total);
    await page.goto('/games/?kind=nope');
    await ready(page);
    await expect(visibleIn(page, cards)).toHaveCount(total);
    expect(errors).toEqual([]);
  });

  test('/works/：按类别筛选整组，状态行计数正确', async ({ page, errors }) => {
    await page.goto('/works/');
    await ready(page);
    const sections = page.locator('section[data-filter-item]');
    const kinds = await sections.count();
    expect(kinds).toBeGreaterThan(1);
    const group = page.getByRole('group', { name: '按类别筛选' });
    await group.getByRole('button').nth(1).click();
    await expect(visibleIn(page, 'section[data-filter-item]')).toHaveCount(1);
    const shown = await visibleIn(page, 'section[data-filter-item]').locator('.card').count();
    await expect(page.locator('[data-list-status]')).toContainText(`共 ${shown} 件作品 · `);
    expect(errors).toEqual([]);
  });
});
