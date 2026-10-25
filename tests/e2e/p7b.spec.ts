import type { Page, Route } from '@playwright/test';
import { test as base, expect } from './fixtures';
import { test as community, uniq } from './community-fixtures';
import { ANON } from '../db/postgrest';
import { handleSubscribe } from '../../src/lib/server/subscribe';
import { createMemoryMailer, type Mail } from '../../src/lib/server/mailer';

/**
 * P7 第二批：
 *  T7.6 中英双语：/en/ 页面 lang、hreflang + x-default、保留路径的语言切换、英文导航、英文 Pagefind 索引
 *  T7.7 内容后台 /cms/：单独的 CSP + noindex（Decap 本身来自 CDN，不在 E2E 里加载）
 *  T7.8 邮件订阅：真实 Postgres + PostgREST + 0016；/api/subscribe 在测试进程里跑真实 Function 逻辑，
 *       发信用内存发信器（永远不真的发信），从「邮件」里取确认 / 退订链接走完整流程
 */
const isDesktop = (name: string) => name.endsWith('-desktop');

async function cspWatch(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

// ------------------------------------------------------------------ T7.6 ----
base.describe('T7.6 中英双语', () => {
  base('英文首页：lang=en、hreflang 三条、导航英文、切换到中文首页', async ({ page, errors }) => {
    await page.goto('/en/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('link[hreflang="zh-CN"]')).toHaveAttribute('href', 'https://azsou.com/');
    await expect(page.locator('link[hreflang="en"]')).toHaveAttribute('href', 'https://azsou.com/en/');
    await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute('href', 'https://azsou.com/');
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
    await expect(page.locator('h1')).toHaveText('Indie apps, AI tools and dev notes');
    await expect(page.locator('.skip-link')).toHaveText('Skip to content');
    await expect(page.locator('[data-lang-switch]')).toHaveAttribute('href', '/');
    // 文章只有中文：如实标注
    await expect(page.locator('section[aria-labelledby="h-articles"] .badge').first()).toHaveText(
      'Chinese only',
    );
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const webPage = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'WebPage');
    expect(webPage.inLanguage).toBe('en');
    expect(errors).toEqual([]);
  });

  base('语言切换保留路径；没有英文版的中文页面切到 /en/', async ({ page }) => {
    await page.goto('/ai/cursor/');
    await expect(page.locator('link[hreflang="en"]')).toHaveAttribute(
      'href',
      'https://azsou.com/en/ai/cursor/',
    );
    await expect(page.locator('[data-lang-switch]')).toHaveAttribute('href', '/en/ai/cursor/');
    await page.locator('[data-lang-switch]').click();
    await expect(page).toHaveURL(/\/en\/ai\/cursor\/$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('h1')).toHaveText('Cursor');
    await expect(page.locator('.app-hero__subtitle')).toHaveText('The AI-first code editor');
    // 按钮直接去官方地址，不经过中文的下载中转页
    await expect(page.locator('.dl-btn').first()).toHaveAttribute('href', /^https:\/\/cursor\.com\//);
    await expect(page.locator('a[hreflang="zh-CN"]', { hasText: '阅读中文版' })).toHaveAttribute(
      'href',
      '/ai/cursor/',
    );
    await page.locator('[data-lang-switch]').click();
    await expect(page).toHaveURL(/\/ai\/cursor\/$/);
    await page.goto('/forum/');
    await expect(page.locator('link[hreflang]')).toHaveCount(0);
    await expect(page.locator('[data-lang-switch]')).toHaveAttribute('href', '/en/');
  });

  base('英文页面的 Ctrl/⌘K 只搜英文索引，界面是英文；没有 CSP 拦截', async ({ page, errors }, info) => {
    base.skip(!isDesktop(info.project.name), '键盘快捷键只在桌面验证');
    const csp = await cspWatch(page);
    await page.goto('/en/videos/');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const box = page.getByRole('combobox', { name: 'Search terms' });
    await expect(box).toBeFocused();
    await box.fill('multiplayer');
    const opts = page.locator('#palette-list [role="option"]');
    await expect(opts.first()).toBeVisible({ timeout: 15_000 });
    for (const href of await opts.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).pathname)))
      expect(href).toMatch(/^\/en\//);
    await expect(opts.first().locator('.badge')).toHaveText(/^(Video|App|AI tool|Game)$/);
    await box.press('Escape');
    expect(await csp()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ------------------------------------------------------------------ T7.7 ----
base.describe('T7.7 内容后台 /cms/', () => {
  base('单独的放宽 CSP 只在 /cms/；noindex；站点页面不受影响', async ({ request }, info) => {
    base.skip(!isDesktop(info.project.name), '响应头与浏览器无关');
    const cms = await request.get('/cms/');
    expect(cms.status()).toBe(200);
    expect(cms.headers()['content-security-policy']).toContain("'unsafe-eval'");
    expect(cms.headers()['x-robots-tag']).toMatch(/noindex/);
    expect(await cms.text()).toContain('decap-cms');
    const cfg = await request.get('/cms/config.yml');
    expect(cfg.headers()['content-type']).toMatch(/yaml/);
    const home = await request.get('/');
    expect(home.headers()['content-security-policy']).not.toContain("'unsafe-eval'");
    expect(home.headers()['content-security-policy']).not.toContain('cdn.jsdelivr.net');
    expect(await (await request.get('/robots.txt')).text()).toContain('Disallow: /cms/');
    expect(await (await request.get('/sitemap-0.xml')).text()).not.toContain('/cms/');
  });
});

// ------------------------------------------------------------------ T7.8 ----
/** /api/subscribe → 测试进程里跑真实的 handleSubscribe（内存发信器），数据库请求转发到本地 PostgREST */
async function realSubscribe(
  page: Page,
  opts: { mailer?: ReturnType<typeof createMemoryMailer> | null } = {},
) {
  const mailer = opts.mailer === undefined ? createMemoryMailer() : opts.mailer;
  const ip = `198.18.0.${Math.floor(Math.random() * 250) + 1}`;
  await page.route('**/api/subscribe', async (route: Route) => {
    const req = route.request();
    const res = await handleSubscribe(
      new Request(req.url(), {
        method: req.method(),
        headers: { 'content-type': 'application/json' },
        body: req.postData() ?? undefined,
      }),
      {},
      {
        mailer,
        defaults: { url: 'https://db.invalid', key: 'pk' },
        verifyFetch: (async (_u: string | URL | Request, init?: RequestInit) =>
          new Response(
            JSON.stringify({ success: String(init?.body).includes('response=XXXX.DUMMY.TOKEN.XXXX') }),
          )) as typeof fetch,
        fetch: (async (u: string | URL | Request, init?: RequestInit) =>
          fetch(String(u).replace('https://db.invalid/rest/v1', process.env.E2E_PGRST!), {
            ...init,
            headers: { 'content-type': 'application/json', Authorization: `Bearer ${ANON}` },
          })) as typeof fetch,
      },
      ip,
    );
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  return mailer;
}
const linkIn = (m: Mail, kind: 'confirm' | 'unsubscribe') =>
  new URL(new RegExp(`https?://[^\\s]+/subscribe/${kind}/#token=[0-9a-f]{64}`).exec(m.text)![0]);

community.describe('T7.8 邮件订阅（真实数据库，内存发信）', () => {
  community('订阅 → 确认邮件 → 确认 → 退订；数据库只存令牌哈希', async ({ page, db }) => {
    community.setTimeout(90_000);
    const mailer = (await realSubscribe(page))!;
    const email = `${uniq('reader')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}@example.com`;
    await page.goto('/subscribe/');
    await page.getByLabel('邮箱地址').fill('not-an-email');
    await page.getByRole('button', { name: '订阅' }).click();
    await expect(page.locator('[data-error-for="email"]')).toContainText('邮箱');
    await page.getByLabel('邮箱地址').fill(email.toUpperCase());
    await expect(page.locator('.fake-turnstile')).toBeVisible();
    await page.getByRole('button', { name: '订阅' }).click();
    await expect(page.locator('[data-form-status]')).toContainText('请查收确认邮件');
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail.to).toBe(email);
    const row = await db.query(
      `select status, confirm_hash, unsubscribe_hash from public.subscribers where email = $1`,
      [email],
    );
    expect(row.rows[0].status).toBe('pending');
    const confirm = linkIn(mail, 'confirm');
    expect(JSON.stringify(row.rows[0])).not.toContain(confirm.hash.slice(7));

    await page.goto(confirm.pathname + confirm.hash);
    await page.getByRole('button', { name: '确认订阅' }).click();
    await expect(page.locator('[data-sub-status]')).toContainText('订阅成功');
    await expect(page).toHaveURL(/\/subscribe\/confirm\/$/);
    expect(
      (await db.query(`select status from public.subscribers where email = $1`, [email])).rows[0].status,
    ).toBe('confirmed');

    const unsub = linkIn(mail, 'unsubscribe');
    await page.goto(unsub.pathname + unsub.hash);
    await page.getByRole('button', { name: '确认退订' }).click();
    await expect(page.locator('[data-sub-status]')).toContainText('已退订');
    expect(
      (await db.query(`select status from public.subscribers where email = $1`, [email])).rows[0].status,
    ).toBe('unsubscribed');
  });

  community('英文订阅页：确认信是英文、链接指向 /en/；没有令牌的确认页提示链接不完整', async ({ page }) => {
    community.setTimeout(60_000);
    const mailer = (await realSubscribe(page))!;
    await page.goto('/en/subscribe/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByLabel('Email address').fill(`en-${Date.now()}@example.com`);
    await expect(page.locator('.fake-turnstile')).toBeVisible();
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(page.locator('[data-form-status]')).toContainText('Check your inbox');
    expect(mailer.sent[0].subject).toBe('Confirm your AZ Studio subscription');
    expect(linkIn(mailer.sent[0], 'confirm').pathname).toBe('/en/subscribe/confirm/');
    await page.goto('/en/subscribe/confirm/');
    await expect(page.locator('[data-sub-status]')).toContainText('incomplete');
    await expect(page.getByRole('button', { name: 'Confirm subscription' })).toBeDisabled();
  });

  community('发信服务没配置：503，页面提示改用 RSS，数据库里没有新行', async ({ page, db }) => {
    await realSubscribe(page, { mailer: null });
    const email = `off-${Date.now()}@example.com`;
    await page.goto('/subscribe/');
    await page.getByLabel('邮箱地址').fill(email);
    await expect(page.locator('.fake-turnstile')).toBeVisible();
    await page.getByRole('button', { name: '订阅' }).click();
    await expect(page.locator('[data-form-status]')).toContainText('暂未开放');
    expect(
      (await db.query(`select count(*)::int as n from public.subscribers where email = $1`, [email])).rows[0]
        .n,
    ).toBe(0);
  });

  community('后台只显示数量：管理员看到表格，版主无权访问', async ({ page, makeUser, signIn }, info) => {
    community.skip(!isDesktop(info.project.name), '后台只在桌面验证');
    const admin = await makeUser(uniq('管理员'), { role: 'admin' });
    await signIn(page, admin);
    await page.goto('/admin/subscribers/');
    await expect(page.locator('[data-status-row="confirmed"] th')).toHaveText('已订阅');
    await expect(page.locator('[data-sub-counts] td').first()).toHaveText(/^\d+$/);
    await expect(page.locator('[data-admin-body]')).not.toContainText('@');
    const mod = await makeUser(uniq('版主'), { role: 'moderator' });
    await signIn(page, mod);
    await page.goto('/admin/subscribers/');
    await expect(page.getByText('这个页面仅管理员可用。')).toBeVisible();
  });
});
