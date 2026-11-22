import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * 应用目录请求乱序：最后一次筛选拥有列表、状态文字与 aria-busy。
 * 只延迟本地静态目录响应；Supabase / Turnstile 沿用 fixtures 的模拟，不接触真实服务。
 */
test.use({ viewport: { width: 390, height: 844 } });

const grid = (page: Page) => page.locator('[data-catalog-grid]');
const cards = (page: Page) => grid(page).locator('[data-entry]');
const status = (page: Page) => page.locator('[data-catalog-status]');
const titles = async (page: Page) =>
  (await cards(page).locator('.entry__title').allTextContents()).map((title) => title.trim());

async function holdCatalog(page: Page) {
  const pending: Route[] = [];
  await page.route('**/apps/catalog.json', (route) => {
    pending.push(route);
  });
  await page.goto('/apps/');
  await expect(page.locator('[data-catalog-filter]')).toHaveAttribute('data-ready', 'yes');
  const initialTitles = await titles(page);
  const initialStatus = await status(page).textContent();
  expect(initialTitles.length).toBeGreaterThan(0);
  await page.locator('[data-more-filters] summary').click();
  return { pending, initialTitles, initialStatus };
}

async function settleResponse(page: Page, route: Route, body: string, fail = false) {
  const completed = fail
    ? page.waitForEvent('requestfailed', (request) => request === route.request())
    : page.waitForEvent('requestfinished', (request) => request === route.request());
  if (fail) await route.abort('failed');
  else await route.fulfill({ contentType: 'application/json', body });
  await completed;
  // 响应结束后让浏览器完成微任务及两个绘制帧，不用固定时间 sleep。
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectBrowserExtensions(page: Page) {
  await expect(page.getByLabel('平台', { exact: true })).toHaveValue('browser-ext');
  await expect(page).toHaveURL(/\/apps\/\?platform=browser-ext$/);
  await expect(cards(page)).toHaveCount(2);
  expect((await titles(page)).sort()).toEqual(['Capture Kit', 'Image Atlas Pro']);
  await expect(status(page)).toHaveText('共 2 个应用 · 按最新排序');
  await expect(page.locator('[data-more-filters-n]')).toHaveText('1');
  await expect(page.locator('[data-catalog-pages]')).toBeHidden();
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
}

for (const stale of ['success', 'error'] as const) {
  test(`catalog race: stale ${stale} cannot replace the latest filter`, async ({ page, request, errors }) => {
    const response = await request.get('/apps/catalog.json');
    expect(response.ok()).toBe(true);
    const body = await response.text();
    const { pending } = await holdCatalog(page);
    const platform = page.getByLabel('平台', { exact: true });
    await platform.selectOption('cli');
    await expect.poll(() => pending.length).toBe(1);
    await platform.selectOption('browser-ext');
    await expect.poll(() => pending.length).toBe(2);
    await expect(grid(page)).toHaveAttribute('aria-busy', 'true');
    await settleResponse(page, pending[1], body);
    await expectBrowserExtensions(page);
    await settleResponse(page, pending[0], body, stale === 'error');
    await expectBrowserExtensions(page);
    expect(pending).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}

test('catalog race: clearing the filter keeps the original static list after a late response', async ({
  page,
  request,
  errors,
}) => {
  const response = await request.get('/apps/catalog.json');
  expect(response.ok()).toBe(true);
  const body = await response.text();
  const { pending, initialTitles, initialStatus } = await holdCatalog(page);
  const platform = page.getByLabel('平台', { exact: true });
  await platform.selectOption('cli');
  await expect.poll(() => pending.length).toBe(1);
  await expect(grid(page)).toHaveAttribute('aria-busy', 'true');
  await platform.selectOption('');
  await expect(page).toHaveURL(/\/apps\/$/);
  await expect(cards(page)).toHaveCount(initialTitles.length);
  expect(await titles(page)).toEqual(initialTitles);
  await expect(status(page)).toHaveText(initialStatus!);
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
  await settleResponse(page, pending[0], body);
  await expect(platform).toHaveValue('');
  await expect(page).toHaveURL(/\/apps\/$/);
  expect(await titles(page)).toEqual(initialTitles);
  await expect(status(page)).toHaveText(initialStatus!);
  await expect(page.locator('[data-more-filters-n]')).toBeHidden();
  await expect(page.locator('[data-catalog-pages]')).toBeHidden();
  await expect(grid(page)).not.toHaveAttribute('aria-busy', 'true');
  expect(pending).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('catalog race: an old response cannot clear busy while the latest request is pending', async ({
  page,
  request,
  errors,
}) => {
  const response = await request.get('/apps/catalog.json');
  expect(response.ok()).toBe(true);
  const body = await response.text();
  const { pending, initialTitles, initialStatus } = await holdCatalog(page);
  const platform = page.getByLabel('平台', { exact: true });
  await platform.selectOption('cli');
  await expect.poll(() => pending.length).toBe(1);
  await platform.selectOption('browser-ext');
  await expect.poll(() => pending.length).toBe(2);
  await settleResponse(page, pending[0], body);
  await expect(platform).toHaveValue('browser-ext');
  await expect(page).toHaveURL(/\/apps\/\?platform=browser-ext$/);
  expect(await titles(page)).toEqual(initialTitles);
  await expect(status(page)).toHaveText(initialStatus!);
  await expect(grid(page)).toHaveAttribute('aria-busy', 'true');
  await settleResponse(page, pending[1], body);
  await expectBrowserExtensions(page);
  expect(pending).toHaveLength(2);
  expect(errors).toEqual([]);
});
