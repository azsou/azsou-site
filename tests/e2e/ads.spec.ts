/**
 * P8 T8.3 / T8.4：广告开启变体（npm run build:ads → dist-ads/，假客户端 ID）在真实浏览器里的表现。
 *  - 广告位预留尺寸（没有填充时也保持高度，CLS 0）
 *  - 广告位与下载 / 跳转按钮（以及正文里的按钮）至少相隔 150px
 *  - Consent Mode v2 默认值先于任何 Google 脚本写入 dataLayer（EEA/UK/CH denied）
 *  - 响应头是放开 Google 来源的 CSP 副本；ads.txt
 * 没有 dist-ads/ 时整个文件跳过（本地只跑默认构建时）。Google 的请求全部拦截，测试不依赖外网。
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { isSupabaseUrl } from '../supabase-route';

const HAS = fs.existsSync('dist-ads/client/index.html') && fs.existsSync('dist-ads.vercel.json');
test.skip(!HAS, '没有广告变体产物（npm run build:ads）');

let server: ChildProcess | null = null;
let base = '';
// eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数用解构写法
test.beforeAll(async ({}, info) => {
  const port = 4400 + info.workerIndex;
  base = `http://127.0.0.1:${port}`;
  server = spawn('node', ['scripts/serve.mjs', String(port), 'dist-ads/client'], {
    env: { ...process.env, AZ_VERCEL_JSON: 'dist-ads.vercel.json' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/')).ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('广告变体静态服务器没有启动');
});
test.afterAll(() => {
  server?.kill();
});

async function open(page: Page, path: string) {
  // 按主机名拦截（不能按整个 URL 匹配 google：同源的 /az-google.js 也会被拦）
  await page.route(
    (u) =>
      /(google|doubleclick|gstatic|adtrafficquality|googlesyndication|googletagmanager)/.test(u.hostname),
    (r) => r.abort(),
  );
  // Supabase 等外部请求同样不需要
  await page.route(isSupabaseUrl, (r) =>
    r.fulfill({ status: 200, body: '[]', contentType: 'application/json' }),
  );
  await page.goto(base + path);
  await page.waitForLoadState('load');
}

const AD_PAGES = [
  '/articles/static-site-strict-csp/',
  '/articles/consent-mode-adsense-prep/',
  '/articles/ai-agent-ci-gates/',
  '/articles/',
];
// 下载 / 跳转按钮，以及正文里任何按钮样式的链接
const KEEP_OUT = 'a[href^="/go/"], a[href*="/go/"], [data-download], [data-go], .prose .btn, .btn--primary';

test('广告位预留尺寸：未填充时也保持高度，加载前后位置不变（CLS 0）', async ({ page }) => {
  await open(page, '/articles/consent-mode-adsense-prep/');
  const slots = page.locator('.ad-slot');
  await expect(slots).toHaveCount(2);
  for (const s of await slots.all()) {
    const ins = s.locator('ins.adsbygoogle');
    const box = await ins.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(250);
    expect(box!.width).toBeGreaterThan(200);
    await expect(s.locator('.ad-slot__label')).toHaveText('广告');
  }
  const y1 = (await slots.first().boundingBox())!.y;
  await page.waitForTimeout(500);
  const y2 = (await slots.first().boundingBox())!.y;
  expect(Math.abs(y2 - y1)).toBeLessThan(1);
  const cls = await page
    .evaluate(
      () =>
        new Promise<number>((resolve) => {
          let v = 0;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
              if (!e.hadRecentInput) v += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => resolve(v), 300);
        }),
    )
    .catch(() => 0); // Firefox / WebKit 不支持 layout-shift：只做上面的位置比较
  expect(cls).toBeLessThan(0.01);
});

for (const path of AD_PAGES) {
  test(`广告与下载 / 跳转按钮相隔 ≥ 150px：${path}`, async ({ page }) => {
    await open(page, path);
    const ads = await page.locator('.ad-slot').all();
    expect(ads.length).toBeGreaterThan(0);
    const buttons = await page.locator(KEEP_OUT).all();
    for (const ad of ads) {
      const a = (await ad.boundingBox())!;
      for (const b of buttons) {
        if (!(await b.isVisible())) continue;
        const r = (await b.boundingBox())!;
        const dx = Math.max(0, r.x - (a.x + a.width), a.x - (r.x + r.width));
        const dy = Math.max(0, r.y - (a.y + a.height), a.y - (r.y + r.height));
        expect(
          Math.hypot(dx, dy),
          `${path} 广告与 ${await b.evaluate((e) => e.outerHTML.slice(0, 80))}`,
        ).toBeGreaterThanOrEqual(150);
      }
    }
  });
}

test('应用详情页（有下载按钮）与不出广告的页面没有广告位', async ({ page }) => {
  for (const p of ['/apps/fablemotion/', '/privacy/', '/login/', '/guestbook/', '/subscribe/', '/']) {
    await open(page, p);
    await expect(page.locator('.ad-slot'), p).toHaveCount(0);
  }
});

test('Consent Mode v2：默认值是 dataLayer 的第一条，EEA/UK/CH 四项 denied，其余地区 granted', async ({
  page,
}) => {
  const google: string[] = [];
  page.on('request', (r) => {
    if (/googlesyndication|googletagmanager/.test(r.url())) google.push(r.url());
  });
  await open(page, '/articles/static-site-strict-csp/');
  const dl = await page.evaluate(() =>
    ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? []).map((a) => Array.from(a)),
  );
  expect(dl[0][0]).toBe('consent');
  expect(dl[0][1]).toBe('default');
  expect(dl[0][2]).toMatchObject({
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500,
  });
  expect(dl[0][2].region).toEqual(expect.arrayContaining(['DE', 'FR', 'GB', 'CH', 'NO']));
  expect(dl[1]).toEqual(['consent', 'default', expect.objectContaining({ ad_storage: 'granted' })]);
  // 默认值之后才请求 AdSense 与 gtag（都被拦截，只看请求顺序）
  expect(google.some((u) => u.includes('adsbygoogle.js?client=ca-pub-0000000000000000'))).toBe(true);
});

test('访客在 Cookie 设置里拒绝广告后，不再请求 AdSense', async ({ page }) => {
  await open(page, '/cookies/');
  await page.locator('input[name="ads"][value="denied"]').check();
  await page.locator('input[name="analytics"][value="denied"]').check();
  await page.locator('[data-consent-form] button[type="submit"]').click();
  await expect(page.locator('[data-consent-status]')).not.toBeEmpty();
  const google: string[] = [];
  page.on('request', (r) => {
    if (/googlesyndication|googletagmanager/.test(r.url())) google.push(r.url());
  });
  await page.goto(base + '/articles/static-site-strict-csp/');
  await page.waitForLoadState('load');
  expect(google).toEqual([]);
  const dl = await page.evaluate(() =>
    ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? []).map((a) => Array.from(a)),
  );
  expect(dl.find((a) => a[1] === 'update')?.[2]).toMatchObject({
    ad_storage: 'denied',
    analytics_storage: 'denied',
  });
});

test('响应头是放开 Google 来源的 CSP；ads.txt 可访问', async ({ request }) => {
  const res = await request.get(base + '/articles/');
  const csp = res.headers()['content-security-policy'];
  expect(csp).toContain('https://pagead2.googlesyndication.com');
  expect(csp).toContain('https://www.googletagmanager.com');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  const txt = await request.get(base + '/ads.txt');
  expect(txt.status()).toBe(200);
  expect(await txt.text()).toBe('google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n');
});
