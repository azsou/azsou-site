import { readFileSync } from 'node:fs';
import { localCsp } from '../../scripts/lib/local-csp.mjs';
import { test, expect, mockTurnstile } from './fixtures';

/**
 * P5 安全头与 CSP：本地静态服务器按 vercel.json 下发同样的响应头（scripts/serve.mjs），
 * 在关键页面上监听 securitypolicyviolation，任何一次拦截都算失败（全部路由的控制台错误检查见 pages.spec）。
 * 另外：404 与离线回退。
 */
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const CSP = vercel.headers
  .find((h) => h.source === '/((?!_astro/|pagefind/|cms/|api/cms/).*)')!
  .headers.find((h) => h.key === 'Content-Security-Policy')!.value;
/** 本地服务器下发的 CSP = vercel.json 的 CSP 经 scripts/lib/local-csp.mjs 改写（去掉 upgrade-insecure-requests；本机栈源） */
const LOCAL_CSP = localCsp(CSP, process.env);

const PAGES = [
  '/',
  '/forum/',
  '/forum/t/t-announce/',
  '/forum/t/?id=11111111-2222-3333-4444-555555555555',
  '/articles/pinyin-initial-search/',
  '/videos/',
  '/videos/designing-claude-code/',
  '/search/?q=fable',
  '/login/',
  '/register/',
  '/reset-password/',
  '/admin/',
  '/guestbook/',
  '/links/',
  '/tags/',
  '/no-such-page/',
];

test.describe('CSP 与安全头', () => {
  test('响应头与 vercel.json 一致（本地去掉 upgrade-insecure-requests；构建指向本机栈时只多放行该 loopback 源）', async ({
    request,
  }) => {
    const r = await request.get('/');
    const h = r.headers();
    expect(h['content-security-policy']).toBe(LOCAL_CSP);
    // 本地改写只允许这两处：去掉 upgrade-insecure-requests、追加 loopback 源；别的指令逐字等于 vercel.json
    const strip = (s: string) =>
      s
        .replace(/;\s*upgrade-insecure-requests/, '')
        .replace(/ (https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/g, '');
    expect(strip(h['content-security-policy'])).toBe(strip(CSP));
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('SAMEORIGIN');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(h['permissions-policy']).toContain('camera=()');
    // CSP 覆盖 Supabase（REST / Auth / Storage 图片 / Realtime）与 Turnstile，禁止内联事件与 eval
    expect(CSP).toMatch(/connect-src [^;]*https:\/\/\*\.supabase\.co/);
    expect(CSP).toMatch(/img-src [^;]*https:\/\/\*\.supabase\.co/);
    expect(CSP).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    // 视频嵌入只放 youtube-nocookie.com（隐私增强模式），不放 youtube.com 主站与通配符
    expect(CSP).toMatch(/frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
    expect(CSP).not.toMatch(/frame-src [^;]*(https:\/\/www\.youtube\.com|\*)/);
    expect(CSP).not.toMatch(/script-src [^;]*'unsafe-(inline|eval)'/);
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("frame-ancestors 'self'");
  });

  test('CSP 只下发给文档与 Worker；/_astro/ 静态资源仍有 nosniff 等安全头', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const asset = /\/_astro\/[^"']+\.js/.exec(html)![0];
    const a = (await request.get(asset)).headers();
    expect(a['content-security-policy']).toBeUndefined();
    expect(a['x-content-type-options']).toBe('nosniff');
    expect(a['cache-control']).toContain('immutable');
    // Service Worker 脚本的 CSP 来自它自己的响应头，必须保留；404 文档也带 CSP
    for (const p of ['/sw.js', '/no-such-page/']) {
      const h = (await request.get(p)).headers();
      expect(h['content-security-policy'], p).toBe(LOCAL_CSP);
    }
  });

  for (const path of PAGES) {
    test(`无 CSP 拦截：${path}`, async ({ page }, info) => {
      test.skip(!/-(desktop|iphone)$/.test(info.project.name), '桌面与 iPhone 视口');
      await mockTurnstile(page);
      await page.addInitScript(() => {
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener('securitypolicyviolation', (e) =>
          (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
        );
      });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      // 注册页：Turnstile 脚本（https://challenges.cloudflare.com）被允许加载并渲染
      if (path === '/register/') await expect(page.locator('.fake-turnstile')).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    });
  }

  test('CSP 确实生效：注入的内联脚本被拦截', async ({ page }, info) => {
    test.skip(!/-desktop$/.test(info.project.name), '仅桌面');
    await page.goto('/');
    const ran = await page.evaluate(async () => {
      const seen = new Promise<string>((r) =>
        document.addEventListener('securitypolicyviolation', (e) => r(e.violatedDirective), { once: true }),
      );
      const s = document.createElement('script');
      s.textContent = 'window.__injected = 1';
      document.body.append(s);
      const directive = await Promise.race([
        seen,
        new Promise<string>((r) => setTimeout(() => r('none'), 2000)),
      ]);
      return { injected: (window as unknown as { __injected?: number }).__injected ?? 0, directive };
    });
    expect(ran.injected).toBe(0);
    expect(ran.directive).toMatch(/^script-src/);
  });
});

test.describe('404 与离线', () => {
  test('未知地址：404 状态、noindex、返回首页链接', async ({ page }) => {
    const res = await page.goto('/definitely/not/here/');
    expect(res?.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('页面不存在');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('main').getByRole('link', { name: /首页/ }).first()).toBeVisible();
  });

  test.describe('离线回退', () => {
    test.use({ serviceWorkers: 'allow' });
    test('断网后打开没缓存过的页面 → 离线页；已访问过的页面 → 缓存版本', async ({
      page,
      context,
      browserName,
    }, info) => {
      test.skip(!/-desktop$/.test(info.project.name), '仅桌面');
      test.skip(browserName === 'firefox' && !!process.env.CI, 'Firefox headless 在 CI 中 SW 不稳定');
      await page.goto('/about/');
      const ready = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        await navigator.serviceWorker.ready;
        for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++)
          await new Promise((r) => setTimeout(r, 100));
        return !!navigator.serviceWorker.controller;
      });
      if (!ready) {
        await page.reload();
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 });
      }
      // 再访问一次，让导航响应进入缓存
      await page.goto('/about/');
      await page.waitForLoadState('networkidle');
      await context.setOffline(true);
      try {
        await page.goto('/apps/');
        await expect(page.locator('h1')).toContainText(/离线|网络/);
        await page.goto('/about/');
        await expect(page.locator('h1')).not.toContainText(/离线/);
      } finally {
        await context.setOffline(false);
      }
    });
  });
});
