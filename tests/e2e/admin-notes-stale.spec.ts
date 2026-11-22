import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { mockAdmin } from '../design/admin-mock';

/**
 * 内部备注的重叠读取：添加备注后会重新读取列表，而首次读取还停在途中时，
 * 较早的读取晚到不得用旧列表盖掉新列表，失败得更晚也不得把整块换成「需要迁移」的提示。
 * 只拦截并延迟本文件登记的备注读取，不连接真实服务，其余后台请求仍由 mockAdmin 夹具返回。
 */
const TARGET = '00000000-0000-4000-8000-0000000002a1';
const USER = {
  id: TARGET,
  display_name: '被查看用户',
  role: 'user',
  banned: false,
  created_at: '2026-11-01T08:00:00Z',
  email: null,
  threads: 0,
  replies: 0,
  comments: 0,
  reports_against: 0,
  ban_reason: null,
  ban_expires_at: null,
};
const NOTE = {
  id: 7,
  target_type: 'profile',
  target_id: TARGET,
  body: '已私信提醒，下次直接隐藏',
  author: null,
  created_at: '2026-11-20T08:00:00Z',
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range',
  'content-range': '*/0',
};
const EMPTY = '还没有备注。';
const MIGRATION = '备注功能需要数据库迁移 0017。';

const notes = (page: Page) => page.locator('[data-notes]');
const addButton = (page: Page) => page.getByRole('button', { name: '添加备注' });

/** 稳定观察「没有再发生」：留出时间让较早的读取把它剩下的步骤走完，再断言。 */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
}

async function setup(page: Page, holdFirstRead: boolean) {
  await mockAdmin(page);
  const held: Route[] = [];
  let reads = 0;
  await page.route('**/rest/v1/rpc/mod_list_users', (route) => {
    const body = route.request().postDataJSON() as { p_id?: string | null };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify(body.p_id === TARGET ? [USER] : []),
    });
  });
  await page.route('**/rest/v1/rpc/mod_list_content', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' }),
  );
  await page.route('**/rest/v1/admin_notes**', (route) => {
    const method = route.request().method();
    if (method === 'POST')
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify([NOTE]),
      });
    if (method !== 'GET') return route.fallback();
    reads += 1;
    if (holdFirstRead && reads === 1) {
      held.push(route);
      return;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify([NOTE]),
    });
  });
  async function release(route: Route, failed = false) {
    const completed = page.waitForEvent('requestfinished', (request) => request === route.request());
    await route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      headers: CORS,
      body: failed ? JSON.stringify({ message: 'intentional notes test failure' }) : '[]',
    });
    await completed;
    await settle(page);
  }
  /** 打开页面并扣住首次备注读取，再添加备注触发第二次读取，较新的列表先显示出来。 */
  async function openAndAdd() {
    await page.goto(`/admin/users/view/?id=${TARGET}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => held.length).toBe(1);
    await page.getByRole('textbox', { name: '新备注' }).fill(NOTE.body);
    await addButton(page).click();
    await expect(notes(page)).toContainText(NOTE.body);
    return held[0];
  }
  return { release, openAndAdd };
}

test.describe('内部备注：重叠读取', () => {
  test('单次读取只显示一份备注', async ({ page }) => {
    await setup(page, false);
    await page.goto(`/admin/users/view/?id=${TARGET}`, { waitUntil: 'domcontentloaded' });
    await expect(notes(page)).toContainText(NOTE.body);
    await expect(notes(page).locator('.note')).toHaveCount(1);
    await expect(page.getByText(EMPTY)).toHaveCount(0);
    await expect(page.getByText(MIGRATION)).toHaveCount(0);
  });

  test('较早的读取晚到，不用旧列表盖掉新列表', async ({ page }) => {
    const env = await setup(page, true);
    const first = await env.openAndAdd();
    await expect(addButton(page)).toBeEnabled();
    await env.release(first);
    await expect(notes(page)).toContainText(NOTE.body);
    await expect(notes(page).locator('.note')).toHaveCount(1);
    await expect(page.getByText(EMPTY)).toHaveCount(0);
  });

  test('较早的读取失败得更晚，不把备注块换成迁移提示', async ({ page }) => {
    const env = await setup(page, true);
    const first = await env.openAndAdd();
    await env.release(first, true);
    await expect(page.getByText(MIGRATION)).toHaveCount(0);
    await expect(notes(page)).toContainText(NOTE.body);
    await expect(notes(page).locator('.note')).toHaveCount(1);
    await expect(addButton(page)).toBeEnabled();
  });
});
