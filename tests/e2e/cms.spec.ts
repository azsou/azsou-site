import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * T9.17 CMS（Decap 3，test-repo 内存后端，不连 GitHub）：字数控件实时计数、超字数保存被拦、
 * 图标预览、预览窗格用站点卡片样式并显示地址 / 分享卡。
 * Decap 来自 CDN（jsdelivr）：只在 chromium-desktop 跑；CDN 不可达时跳过（其余检查见 tests/unit/cms-ext.test.ts）。
 */
const isChromiumDesktop = (n: string) => n === 'chromium-desktop';
const DECAP = 'https://cdn.jsdelivr.net/npm/decap-cms@3.17.1/dist/decap-cms.js';
let decap: Buffer | null = null;

async function openCms(page: Page) {
  // Decap 由测试进程下载一次后交给页面（浏览器不直接连 CDN，结果稳定；完整性校验 SRI 仍由浏览器执行）
  await page.route(DECAP, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: decap!,
    }),
  );
  // 用 test-repo 后端替换 GitHub 后端（其余配置原样）
  await page.route('**/cms/config.yml', async (route) => {
    const res = await route.fetch();
    const yml = (await res.text())
      .replace(/^backend:\n(?: {2}.*\n)+/m, 'backend:\n  name: test-repo\n')
      .replace(/^local_backend: true$/m, 'local_backend: false')
      .replace(/^publish_mode: editorial_workflow$/m, '');
    await route.fulfill({
      response: res,
      body: yml,
      headers: { ...res.headers(), 'content-type': 'text/yaml' },
    });
  });
  await page.goto('/cms/');
  await page.getByRole('button', { name: /登录|Login/ }).click();
}

test.describe('T9.17 CMS 编辑体验', () => {
  test.beforeEach(async ({ page, request }, info) => {
    test.skip(!isChromiumDesktop(info.project.name), 'Decap 只在 chromium-desktop 实测');
    if (!decap)
      decap = await request
        .get(DECAP, { timeout: 30_000 })
        .then((r) => (r.ok() ? r.body() : null))
        .catch(() => null);
    test.skip(!decap, 'CDN 不可达');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('字数计数器 + 超字数保存被拦 + 预览卡片 / 地址 / 分享卡', async ({ page }) => {
    test.setTimeout(90_000);
    await openCms(page);
    await page.goto('/cms/#/collections/apps/new');
    const tagline = page
      .locator('.azc-count')
      .filter({ has: page.locator('input') })
      .nth(2);
    const title = page.locator('.azc-count').first();
    await title.locator('input').fill('Capture Kit');
    await expect(title.locator('.azc-count__n')).toHaveText('5.5 / 14');
    const input = tagline.locator('input');
    await input.fill('一键整理截图并自动生成标注与说明文字吧');
    await expect(tagline.locator('.azc-count__meta')).toHaveClass(/azc-count__meta--over/);
    await expect(tagline.locator('.azc-count__msg')).toHaveText('超出 3 字（上限 16）');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    // 保存被拦：Decap 校验失败时显示字段错误，地址不跳到条目页（test-repo 无编辑流程，按钮是「发布 → 立即发布」）
    await page
      .getByRole('button', { name: /^(保存|发布|Save|Publish)$/ })
      .first()
      .click();
    const now = page.getByText(/^(立即发布|Publish now)$/);
    await now
      .waitFor({ timeout: 3000 })
      .then(() => now.click())
      .catch(() => {});
    await expect(page.getByText(/卡片一句话：超出 3 字/).first()).toBeVisible();
    await expect(page).toHaveURL(/\/collections\/apps\/new$/);
    // 改到范围内：计数器恢复
    await input.fill('一键整理截图');
    await expect(tagline.locator('.azc-count__meta')).not.toHaveClass(/--over/);
    // 预览窗格（iframe）：站点卡片结构 + 地址 + 分享卡
    const frame = page.frameLocator('iframe').first();
    await expect(frame.locator('.app-card .card__title')).toHaveText('Capture Kit');
    await expect(frame.locator('.app-card .card__text')).toHaveText('一键整理截图');
    await expect(frame.locator('.azc-url')).toContainText('https://azsou.com/apps/capture-kit/');
    await expect(frame.locator('.azc-og__title')).toHaveText('Capture Kit · AZ Studio');
    // 图标控件：两档预览
    await expect(page.locator('.azc-icon__tile')).toHaveCount(2);
  });
});
