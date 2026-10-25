import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { emulateColorScheme } from './fixtures';
import { mockAdmin, CONTENT_ROWS } from '../design/admin-mock';

/**
 * T9.16 后台外壳与状态（夹具，不连数据库）：独立外壳（无前台导航 / 页脚 / TabBar）、
 * 内容表的 有数据 / 空 / 错误（重试）/ 加载 / 无权限 五态、行高与复选框命中区、窄屏卡片（不竖排每一列）、
 * 「⋯」菜单键盘操作、批量工具栏、删除二次确认、深浅色 axe 0。
 */
const isMobile = (name: string) => /iphone|android/.test(name);
const rows = (page: Page) => page.locator('tbody[data-rows] tr[data-row]');

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('后台外壳与状态（夹具）', () => {
  test('独立外壳：顶栏（环境标签）+ 侧栏，不渲染前台导航 / 页脚 / TabBar；统计卡等宽', async ({
    page,
  }, info) => {
    await mockAdmin(page);
    await page.goto('/admin/');
    await expect(page.locator('[data-admin-body]')).toBeVisible();
    await expect(page.locator('.admin-top')).toBeVisible();
    await expect(page.locator('[data-admin-env]')).toHaveText('本地');
    await expect(page.locator('.site-nav, .site-footer, .tabbar')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '审计日志' }),
    ).toBeVisible();
    const tiles = page.locator('[data-stats] .stat');
    await expect(tiles).toHaveCount(7);
    const widths = await tiles.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().width)),
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    if (!isMobile(info.project.name)) expect(new Set(widths).size).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('内容表：行高 ≤ 64、复选框命中区 ≥ 32、摘要一行纯文本；窄屏为卡片（主列 + 2 个 meta + 操作）', async ({
    page,
  }, info) => {
    await mockAdmin(page);
    await page.goto('/admin/content/');
    await expect(rows(page)).toHaveCount(CONTENT_ROWS.length);
    const first = rows(page).first();
    // 摘要去掉了 Markdown 记号
    await expect(first.locator('.cell-sub')).toHaveText(
      /^背景 升级到 4\.5 之后，TileMap 被拆成多个 TileMapLayer/,
    );
    const hit = await first.locator('.check-hit').boundingBox();
    expect(hit!.width).toBeGreaterThanOrEqual(32);
    expect(hit!.height).toBeGreaterThanOrEqual(32);
    const heights = await rows(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    if (isMobile(info.project.name)) {
      // 卡片：只显示主列 + 作者 + 状态 + 操作，没有「标签：值」竖排
      const shown = await first.evaluate(
        (tr) => [...tr.children].filter((td) => getComputedStyle(td).display !== 'none').length,
      );
      expect(shown).toBe(5);
      for (const h of heights) expect(h).toBeLessThanOrEqual(96);
    } else {
      for (const h of heights) expect(h).toBeLessThanOrEqual(64);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('「⋯」菜单：键盘打开 / 方向键移动 / Esc 归还焦点；删除二次确认；批量工具栏出现与取消', async ({
    page,
  }) => {
    await mockAdmin(page);
    await page.goto('/admin/content/');
    await expect(rows(page)).toHaveCount(CONTENT_ROWS.length);
    const btn = rows(page).nth(1).getByRole('button', { name: '更多操作' });
    await btn.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: '删除…' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(btn).toBeFocused();
    // 删除：确认框，取消后不发写请求
    let writes = 0;
    page.on('request', (r) => {
      if (r.method() === 'DELETE') writes++;
    });
    await btn.click();
    await page.getByRole('menuitem', { name: '删除…' }).click();
    const dlg = page.locator('dialog[open]');
    await expect(dlg).toContainText('此操作不可撤销');
    await expect(dlg.getByRole('button', { name: '删除' })).toHaveClass(/btn--danger/);
    await dlg.getByRole('button', { name: '取消' }).click();
    await expect(dlg).toHaveCount(0);
    expect(writes).toBe(0);
    // 批量
    await page.getByRole('checkbox', { name: '全选本页' }).check();
    const bar = page.locator('[data-bulkbar]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(`已选 ${CONTENT_ROWS.length} 项`);
    await bar.getByRole('button', { name: '取消选择' }).click();
    await expect(bar).toBeHidden();
  });

  test('空态（筛选后）→ 清除筛选；错误态 → 重试恢复；加载态为骨架', async ({ page }) => {
    const mock = await mockAdmin(page, { state: 'empty' });
    await page.goto('/admin/content/?q=不存在的关键词');
    const empty = page.locator('[data-table-empty]');
    await expect(empty).toContainText('没有符合条件的内容');
    await empty.getByRole('button', { name: '清除筛选' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/$/);
    await expect(page.locator('[data-table-empty]')).toContainText('还没有主题');

    mock.set({ state: 'error' });
    await page.goto('/admin/content/');
    const err = page.locator('[data-table-error]');
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('role', 'alert');
    mock.set({ state: 'data' });
    await err.getByRole('button', { name: '重试' }).click();
    await expect(rows(page)).toHaveCount(CONTENT_ROWS.length);

    mock.set({ state: 'loading' });
    await page.goto('/admin/content/');
    await expect(page.locator('tbody[data-rows]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('tr.table-skel')).toHaveCount(5);
  });

  test('权限：未登录 → 登录卡', async ({ page }) => {
    await mockAdmin(page, { role: 'anon' });
    await page.goto('/admin/content/');
    await expect(page.locator('[data-gate-signed-out]')).toBeVisible();
    await expect(page.locator('[data-admin-body]')).toBeHidden();
  });

  test('权限：普通用户 / 被限制的版主 / 版主进管理员页 各自的状态卡', async ({ page }) => {
    const mock = await mockAdmin(page, { role: 'user' });
    for (const [role, text, path] of [
      ['user', '你的账号没有访问管理后台的权限。', '/admin/'],
      ['banned', '你的账号已被限制，暂时不能使用管理后台。', '/admin/'],
      ['moderator', '这个页面仅管理员可用。', '/admin/settings/'],
    ] as const) {
      mock.set({ role });
      await page.goto(path);
      await expect(page.locator('[data-gate-forbidden]')).toBeVisible();
      await expect(page.locator('[data-gate-forbidden-text]')).toHaveText(text);
      await expect(page.locator('[data-admin-body]')).toBeHidden();
    }
  });

  for (const scheme of ['light', 'dark'] as const)
    test(`axe 0（${scheme}）：概览、内容表（有数据 / 空 / 错）、菜单展开`, async ({ page }) => {
      await emulateColorScheme(page, scheme);
      const mock = await mockAdmin(page);
      for (const state of ['data', 'empty', 'error'] as const) {
        mock.set({ state });
        for (const path of ['/admin/', '/admin/content/']) {
          await page.goto(path);
          await expect(page.locator('[data-admin-body]')).toBeVisible();
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
          expect(await axe(page), `${path} ${state}`).toEqual([]);
        }
      }
      mock.set({ state: 'data' });
      await page.goto('/admin/content/');
      await rows(page).first().getByRole('button', { name: '更多操作' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await axe(page), 'menu').toEqual([]);
    });
});
