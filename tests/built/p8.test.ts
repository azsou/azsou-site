/**
 * P8（默认构建，广告关闭）：不输出任何 Google 代码；没有 ads.txt；法律页齐全且注明日期；页脚链接；没有占位文案；新文章够长。
 * 需要先 npm run build。广告开启变体见 tests/built-ads/。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist/client';
function htmlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && path.relative(ROOT, p) === 'cms') return [];
    return e.isDirectory() ? htmlFiles(p) : e.name.endsWith('.html') ? [p] : [];
  });
}
const files = htmlFiles(ROOT);
const read = (route: string) => fs.readFileSync(path.join(ROOT, route, 'index.html'), 'utf8');
const mainText = (html: string) =>
  (/<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, 'x');

describe('P8 默认构建：广告与统计关闭', () => {
  it('没有 ads.txt', () => {
    expect(fs.existsSync(path.join(ROOT, 'ads.txt'))).toBe(false);
  });
  it('任何页面都没有 Google 加载器、广告位、账户 meta 或 Google 域名脚本', () => {
    for (const f of files) {
      const h = fs.readFileSync(f, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '');
      expect(h, f).not.toContain('az-google.js');
      expect(h, f).not.toMatch(/<ins class="adsbygoogle"/);
      expect(h, f).not.toContain('google-adsense-account');
      expect(h, f).not.toContain('google-site-verification');
      expect(h, f).not.toMatch(/googlesyndication|googletagmanager/);
    }
  });
});

describe('T8.2 法律与说明页', () => {
  const pages = [
    ['/privacy/', '最后更新：2026-10-25'],
    ['/cookies/', '最后更新：2026-10-25'],
    ['/ad-disclosure/', '最后更新：2026-10-25'],
    ['/terms/', '最后更新：2026-10-25'],
    ['/about/', 'Randy Hopkins'],
    ['/contact/', '隐私与数据请求'],
    ['/en/privacy/', 'Last updated: 2026-10-25'],
    ['/en/cookies/', 'Last updated: 2026-10-25'],
    ['/en/ad-disclosure/', 'Last updated: 2026-10-25'],
    ['/en/about/', 'Randy Hopkins'],
    ['/en/contact/', 'Privacy and data requests'],
  ];
  it.each(pages)('%s 存在、可收录、内容充实', (route, text) => {
    const h = read(route);
    expect(h).toContain(text);
    expect(h).toMatch(/name="robots" content="index/);
    expect(mainText(h).replace(/\s+/g, '').length, route).toBeGreaterThan(400);
  });
  it('隐私政策覆盖 Supabase、评论、留言板、订阅、Turnstile、统计、AdSense / Google Cookie、第三方、用户权利、联系', () => {
    const t = mainText(read('/privacy/'));
    for (const k of [
      'Supabase',
      '评论',
      '留言板',
      '订阅',
      'Turnstile',
      'Google Analytics',
      'AdSense',
      'DoubleClick',
      'Consent Mode',
      'Vercel',
      '你的权利',
      '联系我们',
    ])
      expect(t, k).toContain(k);
    expect(read('/privacy/')).toContain('href="https://adssettings.google.com/"');
    const e = mainText(read('/en/privacy/'));
    for (const k of ['Supabase', 'Turnstile', 'AdSense', 'DoubleClick', 'Consent Mode', 'Your rights'])
      expect(e, k).toContain(k);
  });
  it('Cookie 页有隐私选择区（广告关闭时说明没有可选项）', () => {
    const h = read('/cookies/');
    expect(h).toContain('id="choices"');
    expect(h).toContain('没有启用广告和统计');
  });
  it('每个页面的页脚都链接隐私、Cookie、披露页（中文页链中文、英文页链英文）', () => {
    for (const f of files) {
      const h = fs.readFileSync(f, 'utf8');
      const foot = /<footer class="site-footer"[\s\S]*?<\/footer>/.exec(h)?.[0];
      if (!foot) continue;
      const en = /<html lang="en"/.test(h);
      for (const p of ['/privacy/', '/cookies/', '/ad-disclosure/'])
        expect(foot, `${f} ${p}`).toContain(`href="${en ? '/en' : ''}${p}"`);
    }
  });
});

describe('T8.1 内容清理', () => {
  it('没有 lorem / 待补充 / 待作者 / 初稿 / 敬请期待 等占位文案（后台页除外）', () => {
    for (const f of files) {
      if (f.includes(`${path.sep}admin${path.sep}`)) continue;
      const t = mainText(fs.readFileSync(f, 'utf8'));
      expect(t, f).not.toMatch(/lorem ipsum|待补充|待作者|待站长|初稿|敬请期待|TODO|TBD/i);
    }
  });
  it('3 篇新文章已发布，正文 ≥ 1500 个汉字，互相与站内页面有内链', () => {
    for (const slug of ['static-site-strict-csp', 'consent-mode-adsense-prep', 'ai-agent-ci-gates']) {
      const h = read(`/articles/${slug}/`);
      const prose = /<div class="prose">([\s\S]*?)<\/div>\s*<p class="mt-8">/.exec(h)?.[1] ?? '';
      expect(
        (prose.replace(/<[^>]+>/g, '').match(/[\u4e00-\u9fff]/g) ?? []).length,
        slug,
      ).toBeGreaterThanOrEqual(1500);
      expect(
        (
          prose.match(/href="\/(articles|ai|apps|videos|privacy|cookies|ad-disclosure|about|contact)\//g) ??
          []
        ).length,
        slug,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
