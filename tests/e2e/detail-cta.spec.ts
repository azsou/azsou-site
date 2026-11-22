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
  test('游戏详情：试玩 / 看视频 / 上线时通知我 三选一', async ({ page }) => {
    for (const p of ['/games/emberdeep/', '/games/audio-tower-defense/', '/en/games/emberdeep/']) {
      await page.goto(p);
      await primaryAboveFold(page, '[data-game-cta] [data-primary-cta]');
      await expect(page.locator('[data-game-cta] [disabled], [data-game-cta] [aria-disabled]')).toHaveCount(
        0,
      );
    }
  });

  test('T10.15 游戏详情：没有 playUrl / demoVideo 的游戏首屏不出现「可玩 / 试玩」，状态如实', async ({
    page,
  }) => {
    for (const slug of [
      'audio-tower-defense',
      'boids-sandbox',
      'emberdeep',
      'gravity-golf',
      'pixel-dungeon-lab',
      'threejs-rubik',
      'voxel-sculpt',
    ]) {
      await page.goto(`/games/${slug}/`);
      const hero = page.locator('[data-detail-hero]');
      await expect(hero.locator('[data-detail-status]')).not.toBeEmpty();
      await expect(hero).not.toContainText(/可玩|可试用|试玩/);
      await expect(hero.locator('[data-game-cta] [data-notify]')).toHaveCount(1);
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

/**
 * 按访客设备换主按钮时不播放颜色过渡（2026-10-29 CI webkit a11y 首跑失败根因：换 class 落在首帧之后，
 * .btn 的 background-color / color 过渡 160ms，axe 在过渡中取色报 color-contrast；访客也会看到一次闪烁）。
 * 为了不依赖时序：页面一插入下载按钮就强制计算一次样式（相当于「已经画过一帧」），再记录下载区里的 transitionrun。
 * 修复前每个引擎都稳定记录到 6 条过渡；修复后 0 条。
 */
test.describe('详情页：首次推荐主按钮不闪', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  for (const path of ['/ai/chatgpt/', '/apps/e2e-fixture/']) {
    test(`${path}：换主按钮不触发按钮过渡，之后悬停过渡照常`, async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __dlTransitions: string[] };
        w.__dlTransitions = [];
        document.addEventListener(
          'transitionrun',
          (e) => {
            const t = e.target as HTMLElement;
            if (t.closest?.('[data-downloads]')) w.__dlTransitions.push(`${t.dataset.os}:${e.propertyName}`);
          },
          true,
        );
        new MutationObserver((records) => {
          for (const r of records)
            for (const n of r.addedNodes)
              if (n instanceof HTMLElement && n.matches('[data-downloads] [data-os]'))
                void getComputedStyle(n).backgroundColor;
        }).observe(document, { childList: true, subtree: true });
      });
      await page.goto(path);
      const box = page.locator('[data-downloads]');
      // 真的换过主按钮（服务端主按钮是第一个可用平台，iPhone 推荐的不是它），否则这条测试没意义
      const first = await box.locator('a[data-os]').first().getAttribute('data-os');
      await expect(box).toHaveAttribute('data-recommended', /.+/);
      const rec = await box.getAttribute('data-recommended');
      expect(rec, '推荐平台应与服务端默认主按钮不同').not.toBe(first);
      await expect(box.locator('.btn--primary')).toHaveAttribute('data-os', rec!);
      await expect(box).not.toHaveAttribute('data-dl-init');
      await page.waitForTimeout(400); // 过渡 160ms：留足时间让它（如果有）开始
      expect(
        await page.evaluate(() => (window as unknown as { __dlTransitions: string[] }).__dlTransitions),
      ).toEqual([]);
      // 过渡只在首次推荐时关闭：之后按钮的 transition 恢复为组件样式
      const transition = await box
        .locator('.btn--primary')
        .evaluate((b) => getComputedStyle(b).transitionProperty);
      expect(transition).toContain('background-color');
    });
  }
});
