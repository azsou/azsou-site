import { expect, test } from '@playwright/test';
import { mockAdmin } from './admin-mock';
import { settle } from './detect';
import { FIXED_TIME } from './pages';

const cases = [
  { name: 'data-light-320', width: 320, height: 640, theme: 'light', state: 'data' },
  { name: 'data-light-360', width: 360, height: 800, theme: 'light', state: 'data' },
  { name: 'data-light-390', width: 390, height: 844, theme: 'light', state: 'data' },
  { name: 'data-dark-390', width: 390, height: 844, theme: 'dark', state: 'data' },
  { name: 'no-match-light-390', width: 390, height: 844, theme: 'light', state: 'no-match' },
  { name: 'data-light-600', width: 600, height: 900, theme: 'light', state: 'data' },
  { name: 'data-light-1024', width: 1024, height: 768, theme: 'light', state: 'data' },
  { name: 'data-light-1440', width: 1440, height: 900, theme: 'light', state: 'data' },
] as const;

for (const c of cases) {
  test(`official layout ${c.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: c.width, height: c.height });
    await page.emulateMedia({ colorScheme: c.theme, reducedMotion: 'reduce' });
    await mockAdmin(page, { role: 'moderator', state: 'data' });
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    await page.goto('/admin/official/', { waitUntil: 'networkidle' });
    await expect(page.locator('[data-admin-body]')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await settle(page);

    const admin = page.locator('[data-admin][data-section="official"]');
    const root = admin.locator('[data-official]');
    const toolbar = root.getByRole('group', { name: '筛选官方内容', exact: true });
    const query = toolbar.getByRole('searchbox', { name: '关键词', exact: true });
    const kind = toolbar.getByRole('combobox', { name: '类型', exact: true });
    const clear = toolbar.getByRole('button', { name: '清除筛选', exact: true });
    const rows = root.locator('[data-official-row]');
    const visibleRows = root.locator('[data-official-row]:visible');
    const summary = root.locator('[data-official-summary]');
    const noMatch = root.locator('[data-official-no-match]');
    const noMatchClear = noMatch.getByRole('button', { name: '清除筛选', exact: true });
    const originalPaths = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-official-path')),
    );
    const total = originalPaths.length;
    expect(total).toBeGreaterThan(0);
    expect(originalPaths).not.toContain(null);
    expect(new Set(originalPaths).size).toBe(total);
    await expect(admin.locator('.admin-head p')).toHaveText(`共 ${total} 篇；修改沿用仓库审核发布流程。`);
    const notice = admin.locator('[data-admin-body] > .notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('后台不直接修改官方内容（没有 CMS 写入）');
    await expect(notice.locator('code').first()).toHaveText('main');
    await expect(notice.locator('code').last()).toHaveText('src/content.config.ts');
    await expect(query).toBeEnabled();
    await expect(kind).toBeEnabled();
    await expect(clear).toBeDisabled();
    await expect(summary).toHaveText(`显示 ${total} / ${total} 条`);
    await expect(visibleRows).toHaveCount(total);

    const boxes = [];
    for (const control of [query, kind, clear]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Missing official filter control bounds');
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(c.width + 1);
      if (c.width < 600) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      boxes.push(box);
    }
    if (c.width < 600) {
      expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
      expect(Math.abs(boxes[1].y + boxes[1].height - boxes[2].y - boxes[2].height)).toBeLessThanOrEqual(1);
      expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x + 1);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, '官方页不应横向撑开整页').toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => scrollY), '首屏检查不得先滚动').toBe(0);

    if (c.state === 'no-match') {
      await query.fill('zz-f10-official-no-match-20261118');
      await expect(visibleRows).toHaveCount(0);
      await expect(noMatch).toBeVisible();
      await expect(root.locator('[data-official-source-empty]')).toBeHidden();
      await expect(summary).toHaveText(`显示 0 / ${total} 条`);
      const box = await noMatchClear.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Missing no-match clear button bounds');
      expect(await page.evaluate(() => scrollY), '输入后仍须从页面顶部检查').toBe(0);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(c.width + 1);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, '390px 无匹配清除入口应完整进入首屏').toBeLessThanOrEqual(c.height);
    } else if (c.width === 390) {
      const box = await visibleRows.first().boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('Missing first official row bounds');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, '390px 首条官方记录应在纵向完整进入首屏').toBeLessThanOrEqual(c.height);
    }
    await testInfo.attach(`official-layout-${c.name}`, {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });

    if (c.state === 'no-match') {
      await noMatchClear.focus();
      await expect(noMatchClear).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(query).toBeFocused();
      await expect(query).toHaveValue('');
      await expect(noMatch).toBeHidden();
    }
    await query.fill('src/content/apps/fablemotion.md');
    await kind.selectOption('apps');
    await expect(visibleRows).toHaveCount(1);
    const edit = root.getByRole('link', { name: '在 GitHub 编辑：FableMotion（新窗口）', exact: true });
    await expect(edit).toHaveAttribute(
      'href',
      'https://github.com/azsou/azsou-site/edit/main/src/content/apps/fablemotion.md',
    );
    await expect(edit).toHaveAttribute('target', '_blank');
    await expect(clear).toBeEnabled();
    await query.focus();
    await expect(query).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(kind).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(query).toBeFocused();
    await expect(query).toHaveValue('');
    await expect(kind).toHaveValue('all');
    await expect(clear).toBeDisabled();
    await expect(summary).toHaveText(`显示 ${total} / ${total} 条`);
    await expect(visibleRows).toHaveCount(total);
    expect(
      await visibleRows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-official-path'))),
    ).toEqual(originalPaths);
  });
}
