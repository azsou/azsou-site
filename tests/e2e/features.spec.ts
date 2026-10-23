import { test, expect, mockSupabase } from './fixtures';

test.describe('旧 hash 链接跳转', () => {
  for (const [hash, target] of [
    ['#/article/pinyin-initial-search', '/articles/pinyin-initial-search/'],
    ['#/game/emberdeep', '/games/emberdeep/'],
    ['#project', '/apps/fablemotion/'],
    ['#/forum/t-announce', '/forum/t/t-announce/'],
  ]) {
    test(`${hash} → ${target}`, async ({ page }) => {
      await page.goto('/' + hash);
      await expect(page).toHaveURL(new RegExp(target.replace(/[/?]/g, '\\$&') + '$'));
      await expect(page.locator('h1')).toBeVisible();
    });
  }
  test('页内锚点不触发跳转', async ({ page }) => {
    await page.goto('/#main');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe('/');
  });
});

test.describe('路由与服务器行为', () => {
  test('无尾斜杠自动补全', async ({ page }) => {
    await page.goto('/apps/fablemotion');
    await expect(page).toHaveURL(/\/apps\/fablemotion\/$/);
  });
  test('未知地址返回 404 页', async ({ page }) => {
    const res = await page.goto('/no-such-page/');
    expect(res?.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('页面不存在');
  });
  test('sitemap / RSS / robots / manifest 可用', async ({ request }) => {
    const sm = await (await request.get('/sitemap-0.xml')).text();
    expect(sm).toContain('https://azsou.com/articles/pinyin-initial-search/');
    expect(sm).not.toContain('/admin/');
    expect(sm).not.toContain('/search/');
    for (const feed of ['/rss.xml', '/articles/rss.xml', '/forum/rss.xml']) {
      const r = await request.get(feed);
      expect(r.status()).toBe(200);
      expect(await r.text()).toContain('<rss');
    }
    expect(await (await request.get('/robots.txt')).text()).toContain(
      'Sitemap: https://azsou.com/sitemap-index.xml',
    );
    const mf = await (await request.get('/manifest.webmanifest')).json();
    expect(mf.start_url).toBe('/');
    const og = await request.get('/og/art/game-4.png');
    expect(og.headers()['content-type']).toBe('image/png');
  });
  test('安全响应头（与 PR #1 一致）', async ({ request }) => {
    const r = await request.get('/');
    expect(r.headers()['x-content-type-options']).toBe('nosniff');
    expect(r.headers()['x-frame-options']).toBe('SAMEORIGIN');
    expect(r.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

test.describe('搜索', () => {
  test('拼音首字母 dwjgjx 命中单文件工具箱', async ({ page }) => {
    await page.goto('/search/?q=dwjgjx');
    const first = page.locator('[data-results] a').first();
    await expect(first).toContainText('单文件工具箱');
    await first.click();
    await expect(page).toHaveURL(/\/apps\/single-file-toolbox\/$/);
  });
  test('输入即搜', async ({ page }) => {
    await page.goto('/search/');
    await page.getByLabel('搜索关键词').fill('塔防');
    await expect(page.locator('[data-results] a').first()).toContainText('声波塔防');
  });
});

test.describe('只读数据 island', () => {
  test('文章评论：种子 + 数据库评论，用户内容按纯文本渲染', async ({ page }) => {
    await page.goto('/articles/pinyin-initial-search/');
    const box = page.locator('[data-comments]');
    await expect(box).toHaveAttribute('data-state', 'online');
    await expect(box.locator('[data-source="db"]')).toContainText(
      '<script>window.__xss=1</script>数据库评论',
    );
    await expect(box.locator('[data-count]')).toHaveText('2 条');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
  test('后端不可达时进入只读模式', async ({ page }) => {
    await page.unrouteAll();
    await mockSupabase(page, 'down');
    await page.goto('/articles/pinyin-initial-search/');
    const box = page.locator('[data-comments]');
    await expect(box).toHaveAttribute('data-state', 'offline');
    await expect(box.locator('[data-status]')).toContainText('只读模式');
    await expect(box.locator('[data-source="seed"]')).toHaveCount(1);
  });
  test('论坛列表追加数据库主题并可打开', async ({ page }) => {
    await page.goto('/forum/');
    const row = page.locator('[data-forum-list] [data-source="db"] a');
    await expect(row).toContainText('E2E 用户主题');
    await expect(page.locator('[data-seed-id="t-announce"] .list-row__aside')).toHaveText('1 回复');
    await row.click();
    await expect(page).toHaveURL(/\/forum\/thread\/\?id=11111111/);
    await expect(page.locator('h1')).toHaveText('E2E 用户主题');
    await expect(page.locator('[data-body]')).toContainText('<img src=x onerror=');
    await expect(page.locator('[data-list] [data-source="db"]')).toContainText('数据库回复');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
  test('分类页只列本分类', async ({ page }) => {
    await page.goto('/forum/tech/');
    await expect(page.locator('[data-forum-list] [data-source="db"]')).toHaveCount(1);
    await page.goto('/forum/announce/');
    await expect(page.locator('[data-forum-list]')).toHaveAttribute('data-state', 'online');
    await expect(page.locator('[data-forum-list] [data-source="db"]')).toHaveCount(0);
  });
  test('种子主题页追加数据库回复', async ({ page }) => {
    await page.goto('/forum/t/t-announce/');
    await expect(page.locator('[data-forum-replies] [data-source="db"]')).toContainText(
      '种子主题下的数据库回复',
    );
  });
});

test.describe('导航与设计系统', () => {
  test('当前页高亮 + 移动端底部 Tab / 桌面顶部导航', async ({ page }) => {
    await page.goto('/articles/');
    const mobile = (page.viewportSize()?.width ?? 1440) < 768;
    if (mobile) {
      await expect(page.locator('.tabbar')).toBeVisible();
      await expect(page.locator('.tabbar a[aria-current="page"]')).toHaveText(/文章/);
      await expect(page.locator('.nav-links')).toBeHidden();
    } else {
      await expect(page.locator('.tabbar')).toBeHidden();
      await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('文章');
    }
  });
  test('触控目标 ≥ 44px', async ({ page }) => {
    await page.goto('/');
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.site-nav a, .tabbar a, .btn, .site-footer a, .icon-btn')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({
          t: e.textContent?.trim() || e.getAttribute('aria-label'),
          h: e.getBoundingClientRect().height,
          w: e.getBoundingClientRect().width,
        }))
        .filter((r) => r.h < 43.5 || r.w < 43.5),
    );
    expect(small).toEqual([]);
  });
  test('暗色模式跟随系统', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(
      'rgb(0, 0, 0)',
    );
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(
      'rgb(245, 245, 247)',
    );
  });
  test('减少动态效果时关闭过渡', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const d = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')!).transitionDuration);
    expect(parseFloat(d)).toBeLessThan(0.01);
  });
  test('跳到正文链接可用键盘到达', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit 默认 Tab 不聚焦链接（需系统设置），由 axe 覆盖');
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
  });
  test('毛玻璃导航（或实色回退）', async ({ page }) => {
    await page.goto('/');
    const s = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.site-nav')!);
      return {
        bf: cs.backdropFilter || (cs as unknown as Record<string, string>).webkitBackdropFilter || 'none',
        bg: cs.backgroundColor,
      };
    });
    expect(s.bf !== 'none' || s.bg !== 'rgba(0, 0, 0, 0)').toBe(true);
  });
});

test.describe('PWA', () => {
  test.use({ serviceWorkers: 'allow' });
  test('Service Worker 注册成功并缓存离线页', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox' && !!process.env.CI, 'Firefox headless 在 CI 中 SW 不稳定');
    await page.goto('/');
    const ok = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported';
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((r) => setTimeout(() => r(null), 8000)),
      ]);
      if (!reg) return 'timeout';
      for (let i = 0; i < 20; i++) {
        for (const k of await caches.keys())
          if (await (await caches.open(k)).match('/offline/')) return 'cached';
        await new Promise((r) => setTimeout(r, 250));
      }
      return 'no-offline';
    });
    expect(['cached', 'unsupported']).toContain(ok);
  });
});
