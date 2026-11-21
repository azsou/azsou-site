import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { mockAdmin } from '../design/admin-mock';

/**
 * 留言 / 友链审核队列的过期响应：只拦截并延迟本文件登记的审核列表请求，不连接真实服务，
 * 其余后台请求仍由 mockAdmin 夹具返回。先扣住第一次读取，再发起第二次，并按相反顺序放行。
 */
type Status = 'pending' | 'approved';
type Held = { status: Status; route: Route };
type Kind = 'guestbook' | 'links';

const rowId = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const NAMES: Record<Kind, Record<Status, string>> = {
  guestbook: { pending: '待审核留言人', approved: '已通过留言人' },
  links: { pending: '待审核友链站', approved: '已通过友链站' },
};
const CREATED = '2026-11-01T08:00:00Z';

function rows(kind: Kind, status: Status) {
  const name = NAMES[kind][status];
  const id = rowId(status === 'pending' ? 1 : 2);
  return kind === 'guestbook'
    ? [{ id, nickname: name, body: `${name}的留言`, status, created_at: CREATED }]
    : [
        {
          id,
          name,
          url: `https://example.com/${status}`,
          description: '',
          status,
          created_at: CREATED,
          contact: 'owner@example.com',
        },
      ];
}

const list = (page: Page) => page.locator('[data-mod-list]');
const items = (page: Page) => list(page).locator('li.mod-item');
const failure = (page: Page) => page.locator('[data-table-error]');
const pressed = (page: Page, label: string) =>
  page.locator('[data-status-filter]').getByRole('button', { name: label });

async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** 先登记 mockAdmin，再登记本函数：后登记的路由优先，只接管审核列表请求，其余照旧。 */
async function holdQueue(page: Page, kind: Kind) {
  await mockAdmin(page);
  const held: Held[] = [];
  const pattern =
    kind === 'guestbook' ? '**/rest/v1/guestbook_entries?**' : '**/rest/v1/rpc/admin_list_friend_links';
  await page.route(pattern, (route) => {
    const request = route.request();
    const raw =
      kind === 'guestbook'
        ? new URL(request.url()).searchParams.get('status')?.replace(/^eq\./, '')
        : (request.postDataJSON() as { p_status?: string | null }).p_status;
    held.push({ status: raw === 'approved' ? 'approved' : 'pending', route });
  });
  async function release(entry: Held, failed = false) {
    const completed = page.waitForEvent('requestfinished', (request) => request === entry.route.request());
    const body = rows(kind, entry.status);
    await entry.route.fulfill({
      status: failed ? 503 : 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'content-range',
        'content-range': `0-0/${body.length}`,
      },
      body: JSON.stringify(failed ? { message: 'intentional queue test failure' } : body),
    });
    await completed;
    await painted(page);
  }
  /** 打开页面，扣住「待审核」读取，再点「已通过」发起第二次读取，两次读取都在途。 */
  async function openAndSwitch() {
    await page.goto(`/admin/${kind}/`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => held.length).toBe(1);
    expect(held[0].status).toBe('pending');
    await pressed(page, '已通过').click();
    await expect.poll(() => held.length).toBe(2);
    expect(held[1].status).toBe('approved');
    expect(held).toHaveLength(2);
  }
  return { held, release, openAndSwitch };
}

for (const kind of ['guestbook', 'links'] as const) {
  const label = kind === 'guestbook' ? '留言' : '友链';
  const { pending, approved } = NAMES[kind];

  test.describe(`${label}审核队列：过期响应`, () => {
    test('较早发出的成功响应晚到，不覆盖新筛选的结果', async ({ page }) => {
      const queue = await holdQueue(page, kind);
      await queue.openAndSwitch();
      await queue.release(queue.held[1]);
      await expect(items(page)).toHaveCount(1);
      await expect(list(page)).toContainText(approved);
      await expect(list(page)).not.toHaveAttribute('aria-busy', 'true');
      await queue.release(queue.held[0]);
      await expect(items(page)).toHaveCount(1);
      await expect(list(page)).toContainText(approved);
      await expect(list(page)).not.toContainText(pending);
      await expect(pressed(page, '已通过')).toHaveAttribute('aria-pressed', 'true');
      await expect(pressed(page, '待审核')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('[data-status]')).toHaveText('共 1 条');
    });

    test('较早发出的请求失败得更晚，不把新结果换成错误提示', async ({ page }) => {
      const queue = await holdQueue(page, kind);
      await queue.openAndSwitch();
      await queue.release(queue.held[1]);
      await expect(list(page)).toContainText(approved);
      await queue.release(queue.held[0], true);
      await expect(failure(page)).toHaveCount(0);
      await expect(items(page)).toHaveCount(1);
      await expect(list(page)).toContainText(approved);
      await expect(list(page)).not.toHaveAttribute('aria-busy', 'true');
    });

    test('新读取仍在途时，较早响应返回不得提前结束忙碌状态或显示旧列表', async ({ page }) => {
      const queue = await holdQueue(page, kind);
      await queue.openAndSwitch();
      await queue.release(queue.held[0]);
      await expect(list(page)).toHaveAttribute('aria-busy', 'true');
      await expect(items(page)).toHaveCount(0);
      await expect(list(page)).not.toContainText(pending);
      await queue.release(queue.held[1]);
      await expect(list(page)).not.toHaveAttribute('aria-busy', 'true');
      await expect(items(page)).toHaveCount(1);
      await expect(list(page)).toContainText(approved);
      await expect(list(page)).not.toContainText(pending);
    });
  });
}
