import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { CONTENT_ROWS, mockAdmin } from '../design/admin-mock';

/**
 * 内容管理的批量操作：第一次请求还没返回时再点同一个批量按钮，不得再发出第二次请求。
 * 否则同一批内容会被用两个不同的幂等键重复提交，批量删除还会连弹两次确认。
 * 只拦截并延迟本文件登记的批量可见性请求，不连接真实服务，其余后台请求仍由 mockAdmin 夹具返回。
 */
const ROW = CONTENT_ROWS[1];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range',
  'content-range': '*/0',
};
const OK = {
  requested: 1,
  unique: 1,
  duplicates: 0,
  ok: 1,
  failed: 0,
  replayed: false,
  results: [{ id: ROW.id, result: 'ok' }],
};

const bar = (page: Page) => page.locator('[data-bulkbar]');
const hideButton = (page: Page) => page.locator('[data-bulk="hide"]');
const rowBox = (page: Page) => page.locator(`tr[data-id="${ROW.id}"] input[data-select]`);

/** 稳定观察「没有再发生」：留出时间让多余的请求有机会发出，再断言。 */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
}

async function setup(page: Page) {
  await mockAdmin(page);
  const held: Route[] = [];
  let calls = 0;
  await page.route('**/rest/v1/rpc/mod_set_visibility', (route) => {
    calls += 1;
    if (calls === 1) {
      held.push(route);
      return;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(OK),
    });
  });
  async function release(route: Route) {
    const completed = page.waitForEvent('requestfinished', (request) => request === route.request());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(OK),
    });
    await completed;
    await settle(page);
  }
  /** 打开页面，勾选一行，点一次「隐藏」，请求被扣住。 */
  async function openAndHide() {
    await page.goto('/admin/content/', { waitUntil: 'domcontentloaded' });
    await rowBox(page).check();
    await expect(bar(page)).toBeVisible();
    await hideButton(page).click();
    await expect.poll(() => held.length).toBe(1);
    return held[0];
  }
  return { release, openAndHide, calls: () => calls };
}

test.describe('内容管理：批量操作不重复提交', () => {
  test('点一次只发出一次请求，完成后清除选择', async ({ page }) => {
    const env = await setup(page);
    const first = await env.openAndHide();
    await env.release(first);
    expect(env.calls()).toBe(1);
    await expect(bar(page)).toBeHidden();
  });

  test('第一次请求还没返回时再点，不发出第二次请求', async ({ page }) => {
    const env = await setup(page);
    const first = await env.openAndHide();
    await hideButton(page).click();
    await settle(page);
    expect(env.calls()).toBe(1);
    await env.release(first);
    expect(env.calls()).toBe(1);
    await expect(bar(page)).toBeHidden();
  });

  test('第一次完成后可以再次发起', async ({ page }) => {
    const env = await setup(page);
    const first = await env.openAndHide();
    await env.release(first);
    await expect(bar(page)).toBeHidden();
    await rowBox(page).check();
    await expect(bar(page)).toBeVisible();
    await hideButton(page).click();
    await expect.poll(() => env.calls()).toBe(2);
  });
});
