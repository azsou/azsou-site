import type { Page } from '@playwright/test';
import { expect, test, uniq } from './community-fixtures';

// Normal local test accounts and native UI. Only the Storage byte response is stubbed in these browser tests.
// Actual server row visibility is checked by the separate database suite; hosted workflows are not exercised.
const editor = '/admin/official/article-draft/';
const pngPath = '/storage/v1/object/authenticated/az-cms-draft-media-sb05/sb05-check-864e09ae.png';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
// Valid, same-size 1x1 PNG with a different pixel: decoding alone must not accept it.
const alternatePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mOo/w8AAgABf2x1vq4AAAAASUVORK5CYII=',
  'base64',
);
const localHosts = ['localhost', '127.0.0.1', '[::1]'];
const area = (page: Page) => page.getByRole('region', { name: '私图预览测试' });
const start = (page: Page) => page.getByRole('button', { name: '预览测试私图', exact: true });
const finish = (page: Page) => page.getByRole('button', { name: '关闭私图预览', exact: true });

test.beforeEach(async ({ baseURL }) => {
  if (!process.env.CI && !process.env.E2E_PGRST) test.skip(true, 'Local CI fixtures not configured');
  for (const value of [baseURL, process.env.E2E_PGRST, process.env.E2E_DB_URL]) {
    if (!value || !localHosts.includes(new URL(value).hostname))
      throw new Error('SB05 requires loopback fixtures');
  }
});

type Reply = 'ok' | 'denied' | 'wrong-bytes' | 'delayed';
async function trackStorage(page: Page, syntheticToken: string | null, mode: Reply = 'ok') {
  const calls: { expectedGet: boolean; ownSession: boolean }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'authorization,apikey,accept,cache-control,pragma',
    'cache-control': 'no-store',
  };
  await page.route('**/storage/v1/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const expectedGet =
      u.origin === 'http://127.0.0.1:54321' && u.pathname === pngPath && !u.search && req.method() === 'GET';
    // Retain booleans only. Do not log or attach session headers, even for local synthetic accounts.
    const ownSession =
      syntheticToken !== null && (await req.headerValue('authorization')) === `Bearer ${syntheticToken}`;
    calls.push({ expectedGet, ownSession });
    if (mode === 'delayed') await gate;
    try {
      if (!expectedGet || !ownSession || mode === 'denied') {
        await route.fulfill({ status: 403, headers, contentType: 'application/json', body: '{}' });
      } else {
        const body = mode === 'wrong-bytes' ? alternatePng : png;
        await route.fulfill({ status: 200, headers, contentType: 'image/png', body });
      }
    } catch (error) {
      if (mode !== 'delayed') throw error;
      // Closing the preview deliberately aborts the request; some engines discard its intercepted response.
    } finally {
      settle();
    }
  });
  return { calls, release: () => release(), settled };
}

test('站长主动打开才发一次认证读取，显示真实像素，关闭移除私图', async ({ page, makeUser, signIn }) => {
  const user = await makeUser(uniq('私图'), { role: 'admin' });
  const net = await trackStorage(page, user.token);
  await signIn(page, user);
  await page.goto(editor);
  await expect(start(page)).toBeVisible();
  expect(net.calls).toEqual([]);
  await start(page).click();
  const img = area(page).getByRole('img', { name: '合成测试私图' });
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(await img.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([1, 1]);
  expect(net.calls).toEqual([{ expectedGet: true, ownSession: true }]);
  await finish(page).click();
  await expect(area(page).locator('img')).toBeHidden();
  expect(await area(page).locator('img').getAttribute('src')).toBeNull();
  await expect(start(page)).toBeEnabled();
  expect(net.calls).toHaveLength(1);
});

for (const role of ['guest', 'user', 'moderator', 'restricted'] as const) {
  test(`${role} 在原生后台看不到私图入口，不产生对象读取`, async ({ page, makeUser, signIn }) => {
    if (role !== 'guest') {
      const user = await makeUser(uniq('读图'), {
        role: role === 'moderator' ? 'moderator' : 'user',
        banned: role === 'restricted',
      });
      await signIn(page, user);
    }
    const net = await trackStorage(page, null);
    await page.goto(editor);
    await expect(
      page.locator(role === 'guest' ? '[data-gate-signed-out]' : '[data-gate-forbidden]'),
    ).toBeVisible();
    await expect(start(page)).toHaveCount(0);
    await expect(area(page)).toHaveCount(0);
    expect(net.calls).toEqual([]);
  });
}

for (const mode of ['denied', 'wrong-bytes'] as const) {
  test(`${mode} 不显示图片、不改用公开地址或签名链接`, async ({ page, makeUser, signIn }) => {
    const user = await makeUser(uniq('私图'), { role: 'admin' });
    const net = await trackStorage(page, user.token, mode);
    await signIn(page, user);
    await page.goto(editor);
    await start(page).click();
    await expect(area(page).getByRole('status')).toContainText('未能预览测试私图');
    await expect(area(page).locator('img')).toBeHidden();
    expect(await area(page).locator('img').getAttribute('src')).toBeNull();
    expect(net.calls).toEqual([{ expectedGet: true, ownSession: true }]);
  });
}

test('关闭等待读取的预览，迟到的响应也不显示', async ({ page, makeUser, signIn }) => {
  const user = await makeUser(uniq('私图'), { role: 'admin' });
  const net = await trackStorage(page, user.token, 'delayed');
  await signIn(page, user);
  await page.goto(editor);
  await start(page).click();
  try {
    await expect.poll(() => net.calls.length).toBe(1);
    await finish(page).click();
  } finally {
    net.release();
  }
  await net.settled;
  await expect(area(page).getByRole('status')).toHaveText('预览已关闭。');
  expect(await area(page).locator('img').getAttribute('src')).toBeNull();
  expect(net.calls).toEqual([{ expectedGet: true, ownSession: true }]);
});
