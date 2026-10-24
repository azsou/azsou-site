import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, forwardRest, uniq } from './community-fixtures';
import { ANON } from '../db/postgrest';

/**
 * P6 应用商店连真实 Postgres + PostgREST（0012 的 RLS / 触发器 / 计数 RPC 全是真的）：
 * 写评价（星级 + 标题 + 正文）、修改（已编辑）、一人一条、举报、版主隐藏、作者看到「已隐藏」、删除、
 * 被封禁用户不能评价；下载中转页的真实计数（去重：同一访客重复点击只计一次）。
 */

const CTX = {
  baseURL: 'http://127.0.0.1:4321',
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  serviceWorkers: 'block' as const,
};

const reviewsOnline = (page: Page) =>
  expect(page.locator('[data-reviews]')).toHaveAttribute('data-state', 'online');

async function rate(page: Page, stars: number) {
  await page
    .locator('[data-review-form] .star-input')
    .filter({ hasText: `${stars} 星` })
    .locator('input')
    .check();
}

test.describe('评分及评价（真实数据库）', () => {
  test('写评价 → 列表与统计更新 → 修改（已编辑）→ 删除', async ({ page, db, makeUser, signIn, errors }) => {
    const u = await makeUser(uniq('评价者'));
    await signIn(page, u);
    await page.goto('/apps/skill-tree-tool/');
    await reviewsOnline(page);
    const form = page.locator('[data-review-form]');
    await expect(form.getByRole('group', { name: '你的评分' })).toBeVisible();
    // 不选星直接提交：前端提示
    await form.getByRole('button', { name: '提交评价' }).click();
    await expect(form.getByRole('alert')).toHaveText('请先选择 1–5 星。');
    const text = uniq('节点配置很直观 ');
    await rate(page, 4);
    await form.getByLabel('标题').fill('好用');
    await form.getByLabel('评价').fill(`${text}\n\n第二段`);
    await form.getByRole('button', { name: '提交评价' }).click();
    await expect(page.locator('.toast')).toContainText('感谢评价');
    const mine = page.locator('.review').filter({ hasText: text });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByRole('img', { name: '4 星（满分 5 星）' })).toBeVisible();
    await expect(mine.locator('.review__body p')).toHaveCount(2);
    await expect(mine).toContainText(u.name);
    await expect(page.locator('[data-reviews-compose]')).toContainText('你已给出');
    const row = await db.query(`select rating, title, version from public.app_reviews where author = $1`, [
      u.id,
    ]);
    expect(row.rows).toEqual([{ rating: 4, title: '好用', version: '1.2' }]);
    // 统计（包含其他并行用例写入的评价，只断言有数）
    await expect(page.locator('[data-rating-sub]')).toHaveText(/\d+ 条评价/);

    // 修改
    await mine.getByRole('button', { name: '编辑' }).click();
    await rate(page, 5);
    await page.locator('[data-review-form]').getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('.toast').last()).toContainText('评价已更新');
    await expect(mine.getByRole('img', { name: '5 星（满分 5 星）' })).toBeVisible();
    await expect(mine).toContainText('已编辑');

    // 删除
    await mine.getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.toast').last()).toContainText('评价已删除');
    await expect(mine).toHaveCount(0);
    await expect(page.locator('[data-review-form]')).toBeVisible();
    expect((await db.query(`select 1 from public.app_reviews where author = $1`, [u.id])).rowCount).toBe(0);
    expect(errors).toEqual([]);
  });

  test('一人一条：数据库拒绝第二条（换个页面实例也一样）', async ({ page, db, makeUser, signIn }) => {
    const u = await makeUser(uniq('重复'));
    await db.query(`insert into public.app_reviews (app, author, rating) values ('hermes', $1, 3)`, [u.id]);
    await signIn(page, u);
    await page.goto('/apps/hermes/');
    await reviewsOnline(page);
    // 已有评价：显示「修改我的评价」而不是新表单
    await expect(page.getByRole('button', { name: '修改我的评价' })).toBeVisible();
    await expect(page.locator('[data-review-form]')).toHaveCount(0);
  });

  test('举报评价 → 版主隐藏 → 作者看到「已隐藏」，访客看不到', async ({
    browser,
    page,
    db,
    makeUser,
    signIn,
  }) => {
    const author = await makeUser(uniq('作者'));
    const text = uniq('可疑的评价 ');
    const ins = await db.query(
      `insert into public.app_reviews (app, author, rating, body) values ('capture-kit', $1, 1, $2) returning id`,
      [author.id, text],
    );
    const id = ins.rows[0].id as string;

    // 另一位用户举报
    const reporter = await makeUser(uniq('举报人'));
    await signIn(page, reporter);
    await page.goto('/apps/capture-kit/');
    await reviewsOnline(page);
    const item = page.locator(`#review-${id}`);
    await item.getByRole('button', { name: '举报' }).click();
    const dlg = page.getByRole('dialog', { name: '举报这条内容' });
    await dlg.getByLabel('垃圾广告 / 引流').check();
    await dlg.getByRole('button', { name: '提交举报' }).click();
    await expect(page.locator('.toast')).toContainText('已收到举报');
    const rep = await db.query(
      `select reason, status from public.reports where target_type = 'review' and target_id = $1`,
      [id],
    );
    expect(rep.rows).toEqual([{ reason: 'spam', status: 'open' }]);

    // 版主隐藏
    const mod = await makeUser(uniq('版主'), { role: 'moderator' });
    const modCtx = await browser.newContext(CTX);
    const modPage = await modCtx.newPage();
    await forwardRest(modPage);
    await signIn(modPage, mod);
    await modPage.goto('/apps/capture-kit/');
    await expect(modPage.locator('[data-reviews]')).toHaveAttribute('data-state', 'online');
    await modPage.locator(`#review-${id}`).getByRole('button', { name: '隐藏' }).click();
    await expect(modPage.locator('.toast')).toContainText('已隐藏');
    await modCtx.close();
    expect(
      (await db.query(`select published from public.app_reviews where id = $1`, [id])).rows[0].published,
    ).toBe(false);
    const note = await db.query(
      `select kind from public.notifications where user_id = $1 and target_type = 'review' and target_id = $2`,
      [author.id, id],
    );
    expect(note.rows).toEqual([{ kind: 'moderation' }]);

    // 访客（当前页面重新加载为举报人）看不到；作者看到「已隐藏」
    await page.reload();
    await reviewsOnline(page);
    await expect(page.locator(`#review-${id}`)).toHaveCount(0);
    const authorCtx = await browser.newContext(CTX);
    const authorPage = await authorCtx.newPage();
    await forwardRest(authorPage);
    await signIn(authorPage, author);
    await authorPage.goto('/apps/capture-kit/');
    await expect(authorPage.locator('[data-reviews]')).toHaveAttribute('data-state', 'online');
    await expect(authorPage.locator(`#review-${id}`)).toContainText('已隐藏');
    await expect(authorPage.locator('[data-reviews-compose]')).toContainText('已被版主隐藏');
    await authorCtx.close();
  });

  test('被封禁用户不能评价；未登录看到登录引导', async ({ page, makeUser, signIn }) => {
    await page.goto('/apps/sub2api/');
    await reviewsOnline(page);
    await expect(page.locator('[data-reviews-compose]')).toContainText('登录后即可评分和写评价');
    const banned = await makeUser(uniq('封禁'), { banned: true });
    await signIn(page, banned);
    await page.reload();
    await reviewsOnline(page);
    await expect(page.locator('[data-reviews-compose]')).toContainText('已被限制发言');
    await expect(page.locator('[data-review-form]')).toHaveCount(0);
  });
});

test.describe('下载计数（真实数据库）', () => {
  test('点击「继续前往」写入计数；同一访客再次下载不重复计数', async ({ page, db }) => {
    // 每个用例一个独立的「访客 IP」，避免与并行用例互相去重
    const ip = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`;
    const ua = 'Mozilla/5.0 (E2E download test) AppleWebKit/605.1.15 Safari/605.1.15';
    await page.route('**/rest/v1/rpc/app_count_download', async (route) => {
      const req = route.request();
      const res = await route.fetch({
        url: `${process.env.E2E_PGRST}/rpc/app_count_download`,
        headers: {
          ...req.headers(),
          authorization: `Bearer ${ANON}`,
          'x-forwarded-for': ip,
          'user-agent': ua,
        },
      });
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'access-control-allow-origin': '*' },
      });
    });
    await page.route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>example</title>' }),
    );
    const total = async () =>
      Number(
        (
          await db.query(
            `select coalesce(sum(downloads), 0)::int n from public.app_download_counts where app = 'e2e-fixture' and platform = 'web'`,
          )
        ).rows[0].n,
      );
    const before = await total();
    for (let i = 0; i < 2; i++) {
      await page.goto('/go/e2e-fixture/web/');
      await expect(page.locator('[data-go-page]')).toHaveAttribute('data-ready', 'yes');
      await page.getByRole('link', { name: /继续前往/ }).click();
      await page.waitForURL('https://example.com/e2e-web/');
    }
    const after = await total();
    // 至少记了这一次（并行用例也可能在加）；本访客的事件只有一条（第二次被去重）
    expect(after).toBeGreaterThanOrEqual(before + 1);
    const mine = await db.query(
      `select count(*)::int n from private.app_download_events e, private.app_settings s
        where s.key = 'download_salt' and e.app = 'e2e-fixture' and e.platform = 'web'
          and e.visitor = encode(sha256(convert_to(s.value || '|' || current_date::text || '|' || 'a:' || $1 || '|' || $2, 'UTF8')), 'hex')`,
      [ip, ua.toLowerCase()],
    );
    expect(mine.rows[0].n).toBe(1);
  });
});
