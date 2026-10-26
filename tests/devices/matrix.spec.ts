/**
 * T9.19 设备矩阵冒烟（见 playwright.devices.config.ts）。每格：
 *  - 横向溢出 0（scrollWidth ≤ 视口宽）
 *  - 导航可用：≥ 900 顶栏导航可见；< 900 底部 TabBar 可见
 *  - 唯一 h1 可见；主内容区第一个按钮 / 主链接在首屏内可见（详情页的主 CTA）
 *  - 无未捕获脚本错误（pageerror）
 *  - 首屏截图存 test-results/devices/<项目>/<页面>.png，结果行追加到 test-results/devices/<引擎>.jsonl
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const MATRIX_PAGES = [
  { name: 'home', path: '/' },
  { name: 'apps', path: '/apps/' },
  { name: 'app-detail', path: '/apps/fablemotion/', cta: true },
  { name: 'ai-detail', path: '/ai/claude-code/', cta: true },
  { name: 'game-detail', path: '/games/emberdeep/', cta: true },
  { name: 'article-detail', path: '/articles/pinyin-initial-search/' },
  { name: 'forum', path: '/forum/' },
  { name: 'login', path: '/login/' },
  { name: 'en-home', path: '/en/' },
];

const OUT = 'test-results/devices';

for (const p of MATRIX_PAGES) {
  test(`device ${p.name}`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/supabase\.co|challenges\.cloudflare\.com|googlesyndication|googletagmanager/, (r) =>
      r.abort(),
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const t0 = Date.now();
    await page.goto(p.path, { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const vis = (s: string) => {
        const el = document.querySelector<HTMLElement>(s);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden';
      };
      const cta = document.querySelector<HTMLElement>(
        'main .btn--primary, main .detail-cta a, main .detail-cta button, main a.btn, main button.btn',
      );
      const cr = cta?.getBoundingClientRect();
      return {
        vw: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
        nav: vis('.site-nav .nav-links') || vis('.site-nav nav') || vis('.admin-top'),
        tabbar: vis('.tabbar'),
        h1: document.querySelectorAll('h1').length,
        h1Visible: vis('h1'),
        cta: cta ? (cta.textContent || '').trim().slice(0, 20) : null,
        ctaInFold: !!cr && cr.top < innerHeight && cr.bottom > 0 && cr.width > 0,
        height: document.documentElement.scrollHeight,
      };
    });
    const dir = path.join(OUT, info.project.name);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${p.name}.png`) });
    const row = { project: info.project.name, engine: browserName, page: p.name, loadMs, errors, ...m };
    fs.appendFileSync(path.join(OUT, `${browserName}.jsonl`), JSON.stringify(row) + '\n');

    expect(m.overflow, '横向溢出').toBeLessThanOrEqual(0);
    if (m.vw >= 900) expect(m.nav, '≥ 900 顶栏导航可见').toBe(true);
    else expect(m.tabbar, '< 900 底部 TabBar 可见').toBe(true);
    expect(m.h1).toBe(1);
    expect(m.h1Visible).toBe(true);
    if (p.cta) {
      expect(m.cta, '详情页有主按钮').not.toBeNull();
      expect(m.ctaInFold, `主按钮「${m.cta}」在首屏`).toBe(true);
    }
    expect(errors, '无脚本错误').toEqual([]);
  });
}
