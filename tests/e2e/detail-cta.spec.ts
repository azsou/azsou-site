import { expect, test, type Page } from '@playwright/test';

/**
 * T9.12：每个详情页首屏有 1 个可用主按钮（不画禁用按钮；状态驱动）。
 * 应用详情的下载 / 通知逻辑在 apps.spec.ts；这里只断言「首屏、可见、可用、只有一个」。
 */
async function primaryAboveFold(page: Page, selector: string) {
  const el = page.locator(selector);
  await expect(el).toHaveCount(1);
  await expect(el).toBeVisible();
  await expect(el).toBeEnabled();
  await expect(el).not.toHaveAttribute('aria-disabled', 'true');
  const box = (await el.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(box.y + box.height, `${selector} 在首屏内`).toBeLessThanOrEqual(vh);
}

test.describe('详情页首屏主按钮（T9.12）', () => {
  test('游戏详情：试玩 / 观看演示 / 上线时通知我 三选一', async ({ page }) => {
    for (const p of ['/games/emberdeep/', '/games/audio-tower-defense/', '/en/games/emberdeep/']) {
      await page.goto(p);
      await primaryAboveFold(page, '[data-game-cta] [data-primary-cta]');
      await expect(page.locator('[data-game-cta] [disabled], [data-game-cta] [aria-disabled]')).toHaveCount(
        0,
      );
    }
  });

  test('应用详情：主按钮是「获取 / 打开」或「上线时通知我」', async ({ page }) => {
    await page.goto('/apps/fablemotion/');
    await primaryAboveFold(page, '.app-downloads .btn--primary');
  });

  test('视频详情：播放入口在首屏；正文行长 ≤ --reading-max', async ({ page }) => {
    await page.goto('/videos/designing-claude-code/');
    await primaryAboveFold(page, '[data-facade-link]');
    const w = await page.locator('.video-body').evaluate((e) => e.getBoundingClientRect().width);
    const max = await page.evaluate(
      () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 42.5,
    );
    expect(w).toBeLessThanOrEqual(max + 1);
  });
});
