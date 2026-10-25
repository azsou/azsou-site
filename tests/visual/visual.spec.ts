/**
 * Q2 视觉回归（Chromium）。矩阵控制在 CI 可接受的规模：
 *  - 核心页（PAGES 里 core: true）× Q12 全部 9 个视口浅色 + 1440 / 390 深色
 *  - 其余页 × 1440 / 390 浅色（深色由核心页覆盖）
 *  - 强制色、减少动态：首页与 AI 工具详情 1440
 * 只截首屏视口（不截整页），控制基线体积；动态区域（相对时间、计数）用 [data-dynamic] 遮罩。
 * 基线：tests/visual/__screenshots__/，在 CI（ubuntu-latest + fonts-noto-cjk）用
 *   npm run test:visual -- --update-snapshots
 * 生成、人工审阅后提交；本地 arm64 / 其它字体环境生成的基线不要提交。
 */
import { expect, test, type Page } from '@playwright/test';
import { PAGES, VIEWPORTS, FIXED_TIME } from '../design/pages';
import { settle } from '../design/detect';
import { mockAdmin, type AdminMockRole, type AdminMockState } from '../design/admin-mock';

const LITE = [VIEWPORTS[4], VIEWPORTS[1]]; // 1440、390

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(path, { waitUntil: 'networkidle' });
  await settle(page);
  // 懒加载图片滚动触发后回到顶部，避免基线里出现半加载状态
  await page.evaluate(() =>
    document
      .querySelectorAll('img[loading="lazy"]')
      .forEach((i) => ((i as HTMLImageElement).loading = 'eager')),
  );
  await settle(page);
}

const shot = (page: Page, name: string) =>
  expect(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator('[data-dynamic]')], fullPage: false });

for (const p of PAGES) {
  const vps = p.core ? VIEWPORTS : LITE;
  for (const vp of vps) {
    const themes =
      p.core && (vp.name === '1440' || vp.name === '390')
        ? (['light', 'dark'] as const)
        : (['light'] as const);
    for (const theme of themes) {
      test(`${p.name} @${vp.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await open(page, p.path);
        await shot(page, `${p.name}--${vp.name}--${theme}`);
      });
    }
  }
}

for (const name of ['home', 'ai-detail', 'kit', 'kit-prose']) {
  const p = PAGES.find((x) => x.name === name)!;
  test(`${name} forced-colors`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, p.path);
    await shot(page, `${name}--1440--forced`);
  });
  test(`${name} reduced-motion dark`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await open(page, p.path);
    await shot(page, `${name}--1440--reduced-dark`);
  });
}

// T9.16 后台：夹具数据（不连库）下的外壳与各态。概览 / 内容表 1440 深浅 + 390；内容表 空 / 错 / 加载 / 无权限 1440。
const ADMIN_SHOTS: {
  name: string;
  path: string;
  state?: AdminMockState;
  role?: AdminMockRole;
  vps: (typeof VIEWPORTS)[number][];
  dark?: boolean;
}[] = [
  { name: 'admin-dashboard', path: '/admin/', vps: [VIEWPORTS[4], VIEWPORTS[1]], dark: true },
  {
    name: 'admin-content',
    path: '/admin/content/',
    vps: [VIEWPORTS[4], VIEWPORTS[3], VIEWPORTS[1]],
    dark: true,
  },
  {
    name: 'admin-content-empty',
    path: '/admin/content/?q=nothing',
    state: 'empty',
    vps: [VIEWPORTS[4], VIEWPORTS[1]],
  },
  { name: 'admin-content-error', path: '/admin/content/', state: 'error', vps: [VIEWPORTS[4], VIEWPORTS[1]] },
  { name: 'admin-content-loading', path: '/admin/content/', state: 'loading', vps: [VIEWPORTS[4]] },
  { name: 'admin-denied', path: '/admin/settings/', role: 'moderator', vps: [VIEWPORTS[4], VIEWPORTS[1]] },
];
for (const a of ADMIN_SHOTS)
  for (const vp of a.vps)
    for (const theme of a.dark && (vp.name === '1440' || vp.name === '390')
      ? (['light', 'dark'] as const)
      : (['light'] as const))
      test(`${a.name} @${vp.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await mockAdmin(page, { state: a.state, role: a.role });
        await page.clock.setFixedTime(new Date(FIXED_TIME));
        await page.goto(a.path, { waitUntil: a.state === 'loading' ? 'load' : 'networkidle' });
        await expect(page.locator(a.role ? '[data-gate-forbidden]' : '[data-admin-body]')).toBeVisible();
        if (a.state === 'loading') await expect(page.locator('tr.table-skel').first()).toBeVisible();
        else await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await settle(page);
        await shot(page, `${a.name}--${vp.name}--${theme}`);
      });
