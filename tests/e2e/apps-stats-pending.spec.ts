import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

/** 只延迟已模拟的两类统计响应，不连接真实服务；不覆盖项目原有 viewport。 */
type StatsTable = 'app_download_counts' | 'app_review_stats';
type Entry = { slug: string; title: string };
const tables: StatsTable[] = ['app_download_counts', 'app_review_stats'];
const grid = (page: Page) => page.locator('[data-catalog-grid]');
const cards = (page: Page) => grid(page).locator('[data-entry]');
const status = (page: Page) => page.locator('[data-catalog-status]');
const sort = (page: Page) => page.getByRole('combobox', { name: '排序' });

async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function holdStats(page: Page) {
  const pending: Record<StatsTable, Route[]> = { app_download_counts: [], app_review_stats: [] };
  for (const table of tables) {
    await page.route(`**/rest/v1/${table}?**`, (route) => {
      pending[table].push(route);
    });
  }
  await page.goto('/apps/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-catalog-filter]')).toHaveAttribute('data-ready', 'yes');
  for (const table of tables) await expect.poll(() => pending[table].length).toBe(1);
  const initial: Entry[] = await cards(page).evaluateAll((els) =>
    els.map((node) => ({
      slug: (node as HTMLElement).dataset.entry ?? '',
      title: node.querySelector('.entry__title')?.textContent?.trim() ?? '',
    })),
  );
  expect(initial.length).toBeGreaterThan(2);
  expect(new Set(initial.map((entry) => entry.slug)).size).toBe(initial.length);
  expect(initial.every((entry) => entry.slug && entry.title)).toBe(true);
  const initialStatus = await status(page).textContent();
  // 给所有条目设唯一权重，完整预期顺序不调用被测 sortApps。
  const hot = [...initial].reverse();
  const rating = [...initial.slice(1), initial[0]];
  const bodies: Record<StatsTable, unknown> = {
    app_download_counts: hot.map((entry, index) => ({
      app: entry.slug,
      downloads: (hot.length - index) * 10,
    })),
    app_review_stats: rating.map((entry, index) => ({
      app: entry.slug,
      reviews: 1,
      average: 5 - index / (rating.length + 1),
    })),
  };
  async function release(table: StatsTable, failed = false) {
    expect(pending[table]).toHaveLength(1);
    const route = pending[table][0];
    expect(route.request().failure()).toBeNull();
    const completed = page.waitForEvent('requestfinished', (request) => request === route.request());
    await route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(failed ? { message: 'intentional stats test failure' } : bodies[table]),
    });
    await completed;
    await painted(page);
  }
  const expectOneRequestEach = () => {
    for (const table of tables) expect(pending[table]).toHaveLength(1);
  };
  return { initial, initialStatus, hot, rating, pending, release, expectOneRequestEach };
}

/** 每个测试第一次选择统计排序会取目录；请求结束后再观察 pending，而不是等固定毫秒。 */
async function firstStatsSort(page: Page, value: 'hot' | 'rating') {
  const catalogDone = page.waitForEvent(
    'requestfinished',
    (request) => new URL(request.url()).pathname === '/apps/catalog.json',
  );
  await sort(page).selectOption(value);
  await catalogDone;
  await painted(page);
}

async function expectPending(page: Page, pending: Record<StatsTable, Route[]>) {
  for (const table of tables) expect(pending[table][0].request().failure()).toBeNull();
  // 此观察点旧实现会提前清除 busy；立即断言，避免7秒等待把测试拖进8秒API超时。
  expect(await grid(page).getAttribute('aria-busy')).toBe('true');
  expect(await status(page).textContent()).not.toContain('统计数据暂时不可用');
}

async function expectOrder(page: Page, value: 'hot' | 'rating', entries: Entry[]) {
  await expect(sort(page)).toHaveValue(value);
  await expect(page).toHaveURL(new RegExp(`/apps/\\?sort=${value}$`));
  await expect(cards(page)).toHaveCount(entries.length);
  await expect(cards(page).locator('.entry__title')).toHaveText(entries.map((entry) => entry.title));
  await expect(status(page)).toHaveText(
    `共 ${entries.length} 个应用 · 按${value === 'hot' ? '热门' : '评分'}排序`,
  );
  await expect(page.locator('[data-catalog-pages]')).toBeHidden();
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
}

for (const value of ['hot', 'rating'] as const) {
  test(`stats pending: ${value} waits for the existing request instead of reporting unavailable`, async ({
    page,
    errors,
  }) => {
    const held = await holdStats(page);
    await firstStatsSort(page, value);
    await expectPending(page, held.pending);
    await held.release('app_download_counts');
    await expectPending(page, held.pending);
    await held.release('app_review_stats');
    await expectOrder(page, value, held[value]);
    held.expectOneRequestEach();
    expect(errors).toEqual([]);
  });
}

test('stats pending: switching from hot to rating keeps only the latest sort', async ({ page, errors }) => {
  const held = await holdStats(page);
  await firstStatsSort(page, 'hot');
  await sort(page).selectOption('rating');
  await painted(page);
  await expectPending(page, held.pending);
  await held.release('app_download_counts');
  await held.release('app_review_stats');
  await expectOrder(page, 'rating', held.rating);
  held.expectOneRequestEach();
  expect(errors).toEqual([]);
});

test('stats pending: restoring new keeps the original list after statistics arrive', async ({
  page,
  errors,
}) => {
  const held = await holdStats(page);
  await firstStatsSort(page, 'hot');
  await sort(page).selectOption('new');
  await expect(page).toHaveURL(/\/apps\/$/);
  await expect(cards(page).locator('.entry__title')).toHaveText(held.initial.map((entry) => entry.title));
  await expect(status(page)).toHaveText(held.initialStatus!);
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
  await held.release('app_download_counts');
  await held.release('app_review_stats');
  await expect(sort(page)).toHaveValue('new');
  await expect(page).toHaveURL(/\/apps\/$/);
  await expect(cards(page).locator('.entry__title')).toHaveText(held.initial.map((entry) => entry.title));
  await expect(status(page)).toHaveText(held.initialStatus!);
  await expect(page.locator('[data-catalog-pages]')).toBeHidden();
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
  held.expectOneRequestEach();
  expect(errors).toEqual([]);
});

for (const value of ['hot', 'rating'] as const) {
  test(`stats pending: ${value} falls back only after a real mocked statistics failure`, async ({
    page,
    errors,
  }) => {
    const held = await holdStats(page);
    await firstStatsSort(page, value);
    await expectPending(page, held.pending);
    await held.release('app_download_counts', true);
    await held.release('app_review_stats');
    await expect(sort(page)).toHaveValue(value);
    await expect(page).toHaveURL(new RegExp(`/apps/\\?sort=${value}$`));
    await expect(cards(page).locator('.entry__title')).toHaveText(held.initial.map((entry) => entry.title));
    await expect(status(page)).toHaveText(
      `共 ${held.initial.length} 个应用 · 按最新排序（统计数据暂时不可用，已按最新排序）`,
    );
    await expect(page.locator('[data-catalog-pages]')).toBeHidden();
    await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
    await sort(page).selectOption(value === 'hot' ? 'rating' : 'hot');
    await painted(page);
    await expect(status(page)).toContainText('统计数据暂时不可用，已按最新排序');
    held.expectOneRequestEach();
    expect(errors).toEqual([]);
  });
}
