import type { Page, Route } from '@playwright/test';
import { test as base, expect, emulateColorScheme } from './fixtures';
import { test as community, uniq } from './community-fixtures';
import { ANON } from '../db/postgrest';
import { handleCommunitySubmit } from '../../src/lib/server/community-submit';

/**
 * P7 第一批：
 *  T7.1 Ctrl/⌘K 面板 + /search/ 用 Pagefind（中文分词、Worker 的 CSP、无 CSP 拦截）
 *  T7.2 标签云（真实数量、可访问名称）
 *  T7.3 留言板 / T7.4 友链：真实 Postgres + PostgREST + 0015；/api/submit 在测试进程里跑真实的 Function 逻辑
 *       （Turnstile siteverify 用假的「总是通过测试 token」），票据 / 限流 / RLS 全是真的
 *  T7.5 主题：跟随系统、手动切换、持久化、首帧无闪烁
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

// ------------------------------------------------------------------ T7.1 ----
base.describe('T7.1 搜索面板（Pagefind）', () => {
  base(
    'Ctrl/⌘K 打开面板，中文全文搜索，↓ + Enter 打开，Esc 关闭并归还焦点；没有 CSP 拦截',
    async ({ page, errors }, info) => {
      base.skip(!isDesktop(info.project.name), '键盘快捷键只在桌面验证');
      const csp = await cspWatch(page);
      await page.goto('/about/');
      const trigger = page.locator('[data-palette-open]');
      await trigger.focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      const box = page.getByRole('combobox', { name: '搜索关键词' });
      await expect(box).toBeFocused();
      await box.fill('关键帧');
      const opts = page.locator('#palette-list [role="option"]');
      await expect(opts.first()).toBeVisible({ timeout: 15_000 });
      expect(await opts.count()).toBeGreaterThan(1);
      // 命中词高亮（Pagefind 摘要）
      await expect(page.locator('#palette-list mark').first()).toContainText(/关键|帧/);
      await expect(opts.first()).toHaveAttribute('aria-selected', 'true');
      await expect(box).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
      await box.press('ArrowDown');
      await expect(opts.nth(1)).toHaveAttribute('aria-selected', 'true');
      await box.press('Escape');
      await expect(page.locator('dialog[data-palette]')).not.toBeVisible();
      await expect(trigger).toBeFocused();
      // 拼音首字母仍可用（站内索引），Enter 打开第一条
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await box.fill('dwjgjx');
      await expect(opts.first()).toContainText('单文件工具箱');
      await box.press('Enter');
      await expect(page).toHaveURL(/\/apps\/single-file-toolbox\/$/);
      expect(await csp()).toEqual([]);
      expect(errors).toEqual([]);
    },
  );

  base('导航里的搜索按钮打开面板（触屏也可用）；面板只在打开时才下载 Pagefind', async ({ page }) => {
    const pf: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/pagefind/')) pf.push(r.url());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(pf).toEqual([]);
    await page.locator('[data-palette-open]').click();
    const box = page.getByRole('combobox', { name: '搜索关键词' });
    await expect(box).toBeVisible();
    await box.fill('Godot');
    await expect(page.locator('#palette-list [role="option"]').first()).toBeVisible({ timeout: 15_000 });
    expect(pf.some((u) => u.endsWith('/pagefind/pagefind.js'))).toBe(true);
    await page.getByRole('button', { name: '关闭搜索' }).click();
    await expect(box).not.toBeVisible();
  });

  base('/search/ 用 Pagefind：正文里的词也能搜到并高亮', async ({ page }) => {
    const csp = await cspWatch(page);
    await page.goto('/search/?q=' + encodeURIComponent('洋葱皮'));
    const first = page.locator('[data-results] a').first();
    await expect(first).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-results] mark').first()).toContainText(/洋葱|皮/);
    await expect(page.locator('[data-status]')).toContainText(/共 \d+ 条结果/);
    expect(await csp()).toEqual([]);
  });
});

// ------------------------------------------------------------------ T7.2 ----
base.describe('T7.2 标签云', () => {
  base('标签云：真实数量、可访问名称含数量，标签页条目数与云里一致', async ({ page }) => {
    await page.goto('/tags/');
    const tags = page.locator('.tag-cloud a');
    expect(await tags.count()).toBeGreaterThan(50);
    const mcp = page.getByRole('link', { name: /^MCP，\d+ 个条目$/ });
    const n = Number(/(\d+) 个条目/.exec((await mcp.getAttribute('aria-label'))!)![1]);
    expect(n).toBeGreaterThan(1);
    await mcp.click();
    await expect(page).toHaveURL(/\/tags\/mcp\/$/);
    await expect(page.locator('main .list-group a')).toHaveCount(n);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);
  });
  base('只有 1 个条目的标签页 noindex，且不在 sitemap 里', async ({ page, request }) => {
    await page.goto('/tags/rust/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const sm = await (await request.get('/sitemap-0.xml')).text();
    expect(sm).not.toContain('/tags/rust/');
    expect(sm).toContain('/tags/mcp/');
    expect(sm).toContain('/guestbook/');
    expect(sm).toContain('/links/');
  });
});

// ------------------------------------------------------------------ T7.5 ----
base.describe('T7.5 主题', () => {
  const bg = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-bg').trim());

  base('默认跟随系统；按钮在 跟随系统 → 浅色 → 深色 之间切换，刷新后保持', async ({ page }) => {
    await emulateColorScheme(page, 'dark');
    await page.goto('/');
    expect(await bg(page)).toBe('#000000');
    const btn = page.locator('[data-theme-toggle]');
    await expect(btn).toHaveAttribute('aria-label', /外观：跟随系统/);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-label', /外观：浅色/);
    expect(await bg(page)).toBe('#f5f5f7');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    expect(await bg(page)).toBe('#f5f5f7');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-label', /外观：深色/);
    expect(await bg(page)).toBe('#000000');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-label', /外观：跟随系统/);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    expect(await page.evaluate(() => localStorage.getItem('az-theme'))).toBeNull();
  });

  base('首帧无闪烁：手动选深色时，系统是浅色，第一次绘制前 <html> 已是深色', async ({ page }) => {
    await emulateColorScheme(page, 'light');
    await page.addInitScript(() => {
      localStorage.setItem('az-theme', 'dark');
      // 在 <head> 解析时（第一帧之前）记录主题
      new MutationObserver((_, o) => {
        if (document.body) {
          (window as unknown as { __first: string | null }).__first =
            document.documentElement.getAttribute('data-theme');
          o.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/articles/');
    expect(await page.evaluate(() => (window as unknown as { __first: string | null }).__first)).toBe('dark');
    expect(await bg(page)).toBe('#000000');
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#000000');
  });
});

// ------------------------------------------------------------- T7.3 / T7.4 ----
/** /api/submit/* → 在测试进程里跑真实的 handleCommunitySubmit，数据库请求转发到本地 PostgREST */
async function realSubmit(page: Page) {
  const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  await page.route('**/api/submit/**', async (route: Route) => {
    const req = route.request();
    const kind = new URL(req.url()).pathname.split('/').pop();
    const request = new Request(req.url(), {
      method: req.method(),
      headers: { 'content-type': 'application/json' },
      body: req.postData() ?? undefined,
    });
    const res = await handleCommunitySubmit(
      kind,
      request,
      {},
      {
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
}

community.describe('T7.3 留言板（真实数据库）', () => {
  community(
    '匿名留言 → 待审核（公开看不到）→ 版主通过 → 公开显示；审核写审计',
    async ({ page, db, makeUser, signIn }) => {
      community.setTimeout(90_000);
      await realSubmit(page);
      const nick = uniq('访客');
      await page.goto('/guestbook/');
      await expect(page.locator('[data-gb-form]')).toHaveAttribute('data-ready', 'yes');
      await expect(page.locator('[data-gb-status]')).not.toHaveText('正在加载留言…');
      // 校验：空昵称
      await page.getByLabel('留言', { exact: true }).fill('你好，站长');
      await page.getByRole('button', { name: '提交留言' }).click();
      await expect(page.locator('[data-error-for="nickname"]')).toContainText('昵称');
      await expect(page.getByLabel('昵称')).toHaveAttribute('aria-invalid', 'true');
      await page.getByLabel('昵称').fill(nick);
      await expect(page.locator('.fake-turnstile')).toBeVisible();
      await page.getByRole('button', { name: '提交留言' }).click();
      await expect(page.locator('[data-form-status]')).toContainText('审核通过后');
      const row = await db.query(`select id, status from public.guestbook_entries where nickname = $1`, [
        nick,
      ]);
      expect(row.rows[0].status).toBe('pending');
      await page.reload();
      await expect(page.locator('[data-gb-status]')).not.toHaveText('正在加载留言…');
      await expect(page.locator('.gb-entry', { hasText: nick })).toHaveCount(0);

      const mod = await makeUser(uniq('版主'), { role: 'moderator' });
      await signIn(page, mod);
      await page.goto('/admin/guestbook/');
      const card = page.locator('.mod-item', { hasText: nick });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: `通过：${nick}` }).click();
      await expect(card).toHaveCount(0);
      const audit = await db.query(`select action from public.audit_log where actor = $1`, [mod.id]);
      expect(audit.rows.map((r) => r.action)).toContain('guestbook.approved');

      await page.goto('/guestbook/');
      await expect(page.locator('.gb-entry', { hasText: nick })).toContainText('你好，站长');
    },
  );

  community('同一访客 10 分钟内第 4 条被限流，提示中文原因', async ({ page }) => {
    community.setTimeout(90_000);
    await realSubmit(page);
    await page.goto('/guestbook/');
    await expect(page.locator('[data-gb-form]')).toHaveAttribute('data-ready', 'yes');
    for (let i = 1; i <= 4; i++) {
      await page.getByLabel('昵称').fill('限流测试');
      await page.getByLabel('留言', { exact: true }).fill(`第 ${i} 条 ${uniq()}`);
      await expect(page.locator('.fake-turnstile')).toBeVisible();
      await page.getByRole('button', { name: '提交留言' }).click();
      await expect(page.getByRole('button', { name: '提交留言' })).toBeEnabled();
      await expect(page.locator('[data-form-status]')).not.toHaveText('正在提交…');
    }
    await expect(page.locator('[data-form-status]')).toContainText('太频繁');
  });
});

community.describe('T7.4 友链（真实数据库）', () => {
  community(
    '申请 → 版主无权处理 → 管理员看到联系方式并通过 → 友链页显示',
    async ({ page, makeUser, signIn }) => {
      community.setTimeout(90_000);
      await realSubmit(page);
      const name = uniq('测试站');
      const host = `${uniq('s').toLowerCase()}.example.org`;
      await page.goto('/links/');
      await expect(page.locator('[data-link-form]')).toHaveAttribute('data-ready', 'yes');
      await expect(page.getByRole('heading', { name: '作者的账号' })).toBeVisible();
      await expect(page.locator('main a[href="https://github.com/azsou"]')).toBeVisible();
      await page.getByLabel('站点名称').fill(name);
      await page.getByLabel('网址').fill(`http://${host}/`);
      await page.getByRole('button', { name: '提交申请' }).click();
      await expect(page.locator('[data-error-for="url"]')).toContainText('https');
      await page.getByLabel('网址').fill(`https://${host}/`);
      await page.getByLabel('一句话简介（可选）').fill('写独立游戏');
      await page.getByLabel('联系方式（可选，仅站长可见）').fill('owner@example.org');
      await expect(page.locator('.fake-turnstile')).toBeVisible();
      await page.getByRole('button', { name: '提交申请' }).click();
      await expect(page.locator('[data-form-status]')).toContainText('申请已提交');

      const mod = await makeUser(uniq('版主'), { role: 'moderator' });
      await signIn(page, mod);
      await page.goto('/admin/links/');
      await expect(page.locator('[data-gate-forbidden]')).toBeVisible();

      const admin = await makeUser(uniq('管理员'), { role: 'admin' });
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear());
      await signIn(page, admin);
      await page.goto('/admin/links/');
      const card = page.locator('.mod-item', { hasText: name });
      await expect(card).toContainText('owner@example.org');
      await card.getByRole('button', { name: `通过：${name}` }).click();
      await expect(card).toHaveCount(0);

      await page.goto('/links/');
      const link = page.locator('.link-card', { hasText: name });
      await expect(link).toHaveAttribute('href', `https://${host}/`);
      await expect(link).toContainText('写独立游戏');
      await expect(page.locator('main')).not.toContainText('owner@example.org');
    },
  );
});
