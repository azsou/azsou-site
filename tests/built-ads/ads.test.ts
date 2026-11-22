/**
 * 广告开启变体（scripts/build-ads-variant.sh：ca-pub-0000000000000000 + 假广告单元 + 假 GA4 / GSC）：
 * ads.txt、广告位标记、加载器只在允许的页面、账户 meta、CSP 副本。浏览器里的尺寸 / 距离实测见 tests/e2e/ads.spec.ts。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { googleCspState } from '../../scripts/google-csp.mjs';

const ROOT = 'dist-ads/client';
if (!fs.existsSync(path.join(ROOT, 'index.html')))
  throw new Error('没有广告变体产物：先运行 npm run build:ads');
const read = (route: string) =>
  fs.readFileSync(path.join(ROOT, route.endsWith('.html') ? route : path.join(route, 'index.html')), 'utf8');
const CLIENT = 'ca-pub-0000000000000000';

describe('广告开启变体', () => {
  it('ads.txt = google.com, pub-…, DIRECT, f08c47fec0942fa0', () => {
    expect(fs.readFileSync(path.join(ROOT, 'ads.txt'), 'utf8')).toBe(
      'google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n',
    );
  });
  it('长文：文内 + 侧栏广告位，带客户端与单元 ID、「广告」标注', () => {
    const h = read('/articles/consent-mode-adsense-prep/');
    expect(h).toContain(
      `<script src="/az-google.js" defer data-client="${CLIENT}" data-ga="G-TEST000000"></script>`,
    );
    const ins = [...h.matchAll(/<ins class="adsbygoogle"[^>]*>/g)].map((m) => m[0]);
    expect(ins).toHaveLength(2);
    expect(ins[0]).toContain('data-ad-slot="1111111111"');
    expect(ins[1]).toContain('data-ad-slot="2222222222"');
    for (const i of ins) {
      expect(i).toContain(`data-ad-client="${CLIENT}"`);
      expect(i).toContain('style="display:block"');
    }
    expect(h).toContain('aria-label="广告"');
    // 文内广告在正文里，切在二级标题前
    expect(h).toMatch(/<aside class="ad-slot ad-slot--article"[\s\S]*?<\/aside>\s*<h2 id="a-sec-\d">/);
  });
  it('短文（V72 迁移文章）没有广告位', () => {
    expect(read('/articles/sw-offline-shell/')).not.toContain('<ins class="adsbygoogle"');
  });
  it('文章列表：每 6 篇之后一个列表广告位', () => {
    const h = read('/articles/');
    const n = (h.match(/data-ad-slot="3333333333"/g) ?? []).length;
    const cards = (h.match(/<article class="card">/g) ?? []).length;
    expect(n).toBe(Math.floor((cards - 1) / 6));
    expect(n).toBeGreaterThan(0);
  });
  it('不出广告的页面：没有广告位，加载器不带 data-client（只有 GA4）', () => {
    for (const r of [
      '/',
      '/privacy/',
      '/cookies/',
      '/ad-disclosure/',
      '/about/',
      '/contact/',
      '/terms/',
      '/login/',
      '/register/',
      '/guestbook/',
      '/subscribe/',
      '/forum/new/',
      '/404.html',
      '/en/',
      '/en/privacy/',
      '/apps/fablemotion/',
    ]) {
      const h = read(r);
      expect(h, r).not.toContain('<ins class="adsbygoogle"');
      if (r === '/apps/fablemotion/') continue; // 应用详情页允许加载器，但页面上没有任何广告位
      expect(h, r).not.toContain('data-client=');
    }
  });
  it('后台与认证回调页不加载任何 Google 脚本', () => {
    for (const r of ['/admin/', '/auth/callback/', '/reset-password/'])
      expect(read(r), r).not.toContain('az-google.js');
  });
  it('账户 meta 每页都有（AdSense 审核验证站点）；GSC 验证 meta 只在首页', () => {
    expect(read('/')).toContain(`<meta name="google-adsense-account" content="${CLIENT}">`);
    expect(read('/privacy/')).toContain('google-adsense-account');
    expect(read('/')).toContain(
      '<meta name="google-site-verification" content="dummy-gsc-verification-token">',
    );
    expect(read('/articles/')).not.toContain('google-site-verification');
  });
  it('Cookie 页显示广告 / 统计开关', () => {
    const h = read('/cookies/');
    expect(h).toContain('name="ads"');
    expect(h).toContain('name="analytics"');
  });
  it('CSP 副本放开了 AdSense + GA4，提交的 vercel.json 仍是严格策略', () => {
    const csp = (file: string) =>
      JSON.parse(fs.readFileSync(file, 'utf8'))
        .headers.find((h: { source: string }) => h.source.startsWith('/((?!_astro/'))
        .headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value as string;
    expect(googleCspState(csp('dist-ads.vercel.json'))).toEqual({ ads: true, ga: true });
    expect(googleCspState(csp('vercel.json'))).toEqual({ ads: false, ga: false });
  });
});
