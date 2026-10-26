/** P8 变现：AdSense / GA4 配置、ads.txt、CSP 开关、广告放置规则、联盟链接、Cookie 清单 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AD_FREE_PREFIXES,
  MIN_AD_ARTICLE_CHARS,
  adSlotId,
  adsAllowedOn,
  adsTxt,
  adsenseClient,
  analyticsAllowedOn,
  applyGoogleCsp,
  ga4Id,
  googleCspSources,
  googleCspState,
  gscVerification,
  publisherId,
  splitForInArticleAd,
  textLength,
} from '@/lib/ads';
import { countSponsored, markSponsored } from '@/lib/sponsored';
import { contactEmail } from '@/lib/contact';
import { STORAGE_ITEMS } from '@/lib/cookies';
import { EN_SECTIONS } from '@/lib/i18n';

const root = path.resolve(__dirname, '../..');
const DUMMY = 'ca-pub-0000000000000000';
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const pageCsp: string = vercel.headers
  .find((h: { source: string }) => h.source === '/((?!_astro/|pagefind/|cms/|api/cms/).*)')
  .headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;

describe('T8.3 配置与 ads.txt', () => {
  it('默认（没设变量）全部关闭', () => {
    expect(adsenseClient({})).toBeNull();
    expect(adsTxt({})).toBeNull();
    expect(ga4Id({})).toBeNull();
    expect(gscVerification({})).toBeNull();
    expect(adSlotId({}, 'article')).toBeNull();
  });
  it('格式不对的客户端 ID 视为未设置（不输出坏代码）', () => {
    for (const bad of [
      'pub-0000000000000000',
      'ca-pub-123',
      'ca-pub-00000000000000001',
      ' ',
      'ca-pub-abcdefghijklmnop',
    ])
      expect(adsenseClient({ PUBLIC_ADSENSE_CLIENT: bad }), bad).toBeNull();
    expect(adsenseClient({ PUBLIC_ADSENSE_CLIENT: ` ${DUMMY} ` })).toBe(DUMMY);
  });
  it('ads.txt：ca-pub-… → pub-…，Google 的 TAG-ID，DIRECT', () => {
    expect(publisherId(DUMMY)).toBe('pub-0000000000000000');
    expect(adsTxt({ PUBLIC_ADSENSE_CLIENT: DUMMY })).toBe(
      'google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n',
    );
  });
  it('广告单元 ID、GA4、GSC 校验', () => {
    expect(adSlotId({ PUBLIC_ADSENSE_SLOT_LIST: '3333333333' }, 'list')).toBe('3333333333');
    expect(adSlotId({ PUBLIC_ADSENSE_SLOT_LIST: 'abc' }, 'list')).toBeNull();
    expect(ga4Id({ PUBLIC_GA4_ID: 'G-ABC123XYZ' })).toBe('G-ABC123XYZ');
    expect(ga4Id({ PUBLIC_GA4_ID: 'UA-1234-1' })).toBeNull();
    expect(gscVerification({ PUBLIC_GSC_VERIFICATION: 'abcDEF_123-xyz' })).toBe('abcDEF_123-xyz');
    expect(gscVerification({ PUBLIC_GSC_VERIFICATION: '<script>' })).toBeNull();
  });
});

describe('T8.3 放置规则', () => {
  it('后台、认证、CMS、留言板表单、订阅、404、法律页、首页不出广告；中英文同一规则', () => {
    for (const p of [
      '/',
      '/admin/',
      '/admin/users/',
      '/login/',
      '/register/',
      '/cms/',
      '/auth/callback/',
      '/guestbook/',
      '/subscribe/',
      '/subscribe/confirm/',
      '/404/',
      '/404.html',
      '/privacy/',
      '/cookies/',
      '/terms/',
      '/ad-disclosure/',
      '/about/',
      '/contact/',
      '/go/fablemotion/windows/',
      '/forum/new/',
      '/en/',
      '/en/privacy/',
      '/en/subscribe/',
    ])
      expect(adsAllowedOn(p), p).toBe(false);
    for (const p of ['/articles/', '/articles/static-site-strict-csp/', '/videos/', '/en/articles/'])
      expect(adsAllowedOn(p), p).toBe(true);
    expect(AD_FREE_PREFIXES).toContain('/admin/');
  });
  it('GA4 不在后台 / CMS / 认证与令牌页加载', () => {
    for (const p of ['/admin/', '/cms/', '/auth/callback/', '/reset-password/', '/subscribe/confirm/'])
      expect(analyticsAllowedOn(p), p).toBe(false);
    expect(analyticsAllowedOn('/articles/')).toBe(true);
  });
  it('文内广告：短文不插；长文插在第 2 个二级标题前；切点附近有按钮不插', () => {
    const para = (n: number) => `<p>${'字'.repeat(n)}</p>`;
    const short = `${para(300)}<h2 id="a">一</h2>${para(300)}`;
    expect(splitForInArticleAd(short)).toBeNull();
    const long = `${para(400)}<h2 id="a">一</h2>${para(400)}<h2 id="b">二</h2>${para(900)}`;
    expect(textLength(long)).toBeGreaterThanOrEqual(MIN_AD_ARTICLE_CHARS);
    const parts = splitForInArticleAd(long);
    expect(parts).not.toBeNull();
    expect(parts![1].startsWith('<h2 id="b">')).toBe(true);
    expect(parts!.join('')).toBe(long);
    const withBtn = `${para(400)}<h2 id="a">一</h2>${para(300)}<a class="btn" href="/go/x/windows/">下载</a><h2 id="b">二</h2>${para(900)}`;
    expect(splitForInArticleAd(withBtn)).toBeNull();
  });
  it('新文章足够长，会有文内广告位；V72 短文没有', () => {
    const body = (slug: string) =>
      fs
        .readFileSync(path.join(root, 'src/content/articles', `${slug}.md`), 'utf8')
        .split(/^---$/m)
        .slice(2)
        .join('---');
    for (const s of ['static-site-strict-csp', 'consent-mode-adsense-prep', 'ai-agent-ci-gates'])
      expect(splitForInArticleAd(body(s)), s).not.toBeNull();
    expect(splitForInArticleAd(body('sw-offline-shell'))).toBeNull();
  });
});

describe('T8.3 CSP 开关', () => {
  it('提交的 vercel.json 是严格 CSP：没有任何 Google 来源', () => {
    expect(googleCspState(pageCsp)).toEqual({ ads: false, ga: false });
    expect(pageCsp).not.toMatch(/google|doubleclick/);
  });
  it('开启后包含 AdSense / GA4 来源，script-src 仍无 unsafe-inline / unsafe-eval；关闭后逐字恢复', () => {
    const on = applyGoogleCsp(pageCsp, { ads: true, ga: true });
    expect(googleCspState(on)).toEqual({ ads: true, ga: true });
    const scriptSrc = /script-src ([^;]*)/.exec(on)![1].split(' ');
    expect(scriptSrc).toContain('https://pagead2.googlesyndication.com');
    expect(scriptSrc).toContain('https://www.googletagmanager.com');
    expect(scriptSrc).toContain('https://fundingchoicesmessages.google.com');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(/frame-src ([^;]*)/.exec(on)![1]).toContain('https://*.doubleclick.net');
    expect(applyGoogleCsp(on, { ads: false, ga: false })).toBe(pageCsp);
    // 只开 GA4：不放开广告帧
    const ga = applyGoogleCsp(pageCsp, { ads: false, ga: true });
    expect(googleCspState(ga)).toEqual({ ads: false, ga: true });
    expect(ga).not.toContain('doubleclick');
    expect(Object.keys(googleCspSources({ ads: false, ga: false }))).toHaveLength(0);
  });
});

describe('T8.4 Consent Mode v2 加载器', () => {
  const js = fs.readFileSync(path.join(root, 'public/az-google.js'), 'utf8');
  it('先设默认值（四项 denied + EEA/UK/CH region + wait_for_update），再加载任何 Google 脚本', () => {
    const def = js.indexOf("'consent', 'default'");
    expect(def).toBeGreaterThan(0);
    expect(js.indexOf('pagead2.googlesyndication.com')).toBeGreaterThan(def);
    expect(js.indexOf('googletagmanager.com/gtag/js')).toBeGreaterThan(def);
    for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'])
      expect(js).toContain(k);
    for (const r of ["'DE'", "'FR'", "'GB'", "'CH'", "'NO'", "'IS'", "'LI'"]) expect(js).toContain(r);
    expect(js).toContain('wait_for_update = 500');
    expect(js).toContain("'ads_data_redaction', true");
  });
  it('访客拒绝后不加载对应脚本；没有广告位的页面不加载 AdSense', () => {
    expect(js).toMatch(/client && slots\.length && !\(choice && choice\.ads === 'denied'\)/);
    expect(js).toMatch(/ga && !\(choice && choice\.analytics === 'denied'\)/);
  });
});

describe('T8.7 联盟 / 赞助链接', () => {
  it('列出的地址与 data-sponsored 链接加 rel="sponsored nofollow noopener"，保留已有 rel，其他链接不动', () => {
    const html =
      '<p><a href="https://shop.example.com/x?a=1&amp;b=2">买</a> <a href="https://other.example.com/">别的</a> ' +
      '<a data-sponsored href="https://s.example.com/" rel="noreferrer">赞助</a> <a href="/apps/">站内</a></p>';
    const out = markSponsored(html, ['https://shop.example.com/x?a=1&b=2']);
    expect(out).toContain(
      '<a href="https://shop.example.com/x?a=1&amp;b=2" rel="sponsored nofollow noopener">',
    );
    expect(out).toContain('<a href="https://other.example.com/">');
    expect(out).toContain('rel="noreferrer sponsored nofollow noopener"');
    expect(out).toContain('<a href="/apps/">');
    expect(countSponsored(out)).toBe(2);
    expect(markSponsored(out, ['https://shop.example.com/x?a=1&b=2'])).toBe(out);
  });
  it('赞助位默认关闭、没有任何赞助方（不放假赞助）', () => {
    const s = JSON.parse(fs.readFileSync(path.join(root, 'src/data/sponsors.json'), 'utf8'));
    expect(s.enabled).toBe(false);
    expect(s.sponsors).toEqual([]);
  });
  it('现有文章没有未披露的联盟链接', () => {
    const dir = path.join(root, 'src/content/articles');
    for (const f of fs.readdirSync(dir)) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = JSON.parse(t.split(/^---$/m)[1]);
      if (countSponsored(t) > 0 || (fm.sponsoredLinks ?? []).length) expect(fm.disclosure, f).toBeTruthy();
    }
  });
});

describe('T8.2 法律页与联系方式', () => {
  it('联系邮箱只接受合法地址，默认不公开', () => {
    expect(contactEmail({})).toBeNull();
    expect(contactEmail({ PUBLIC_CONTACT_EMAIL: 'hi@azsou.com' })).toBe('hi@azsou.com');
    expect(contactEmail({ PUBLIC_CONTACT_EMAIL: 'not an email' })).toBeNull();
  });
  it('Cookie 清单覆盖站内实际使用的存储键与 Google Cookie', () => {
    const names = STORAGE_ITEMS.map((i) => i.name).join(' ');
    for (const k of [
      'az-session-v68',
      'az-pkce-verifier',
      'az-theme',
      'az-consent',
      'az-site-settings-v1',
      'az_cms_state',
      '_ga',
      '__gads',
      'FCCDCF',
    ])
      expect(names).toContain(k);
    const js = fs.readFileSync(path.join(root, 'public/az-google.js'), 'utf8');
    expect(js).toContain("'az-consent'");
  });
  it('关于 / 联系 / 隐私 / Cookie / 披露页都有英文版并互为 hreflang', () => {
    for (const p of ['/about/', '/contact/', '/privacy/', '/cookies/', '/ad-disclosure/']) {
      expect(EN_SECTIONS).toContain(p);
      expect(fs.existsSync(path.join(root, 'src/pages', `${p.slice(1, -1)}.astro`)), p).toBe(true);
      expect(fs.existsSync(path.join(root, 'src/pages/en', `${p.slice(1, -1)}.astro`)), `/en${p}`).toBe(true);
    }
  });
});
