/**
 * Cookie 与本地存储清单（/cookies/ 与 /en/cookies/ 共用）。新增任何存储项时同步更新这里与隐私政策。
 * kind：necessary = 必要（不需要同意）；preference = 偏好；analytics / ads = 只有启用对应 Google 服务时才存在。
 */
export interface StorageItem {
  name: string;
  kind: 'necessary' | 'preference' | 'analytics' | 'ads';
  where: { zh: string; en: string };
  purpose: { zh: string; en: string };
  lifetime: { zh: string; en: string };
}

export const STORAGE_ITEMS: StorageItem[] = [
  {
    name: 'az-session-v68',
    kind: 'necessary',
    where: { zh: '本站 · localStorage', en: 'This site · localStorage' },
    purpose: { zh: '保持登录状态（Supabase 会话凭据）', en: 'Keeps you signed in (Supabase session)' },
    lifetime: { zh: '退出登录时删除', en: 'Removed when you sign out' },
  },
  {
    name: 'az-pkce-verifier',
    kind: 'necessary',
    where: { zh: '本站 · localStorage', en: 'This site · localStorage' },
    purpose: {
      zh: '第三方登录（GitHub / Google）回调校验',
      en: 'Verifies the GitHub / Google sign-in callback',
    },
    lifetime: { zh: '登录完成后删除', en: 'Removed after sign-in completes' },
  },
  {
    name: 'az_cms_state',
    kind: 'necessary',
    where: { zh: '本站 · Cookie（仅 /api/cms/）', en: 'This site · cookie (/api/cms/ only)' },
    purpose: {
      zh: '内容后台 GitHub 授权的防伪造校验，只有站长会用到',
      en: 'CSRF check for the owner-only CMS GitHub sign-in',
    },
    lifetime: { zh: '10 分钟', en: '10 minutes' },
  },
  {
    name: 'az-site-settings-v1',
    kind: 'necessary',
    where: { zh: '本站 · sessionStorage', en: 'This site · sessionStorage' },
    purpose: { zh: '缓存站点公告与论坛设置，减少请求', en: 'Caches the site banner and forum settings' },
    lifetime: { zh: '关闭标签页时删除（最长 5 分钟）', en: 'Until the tab closes (max 5 minutes)' },
  },
  {
    name: 'Service Worker 缓存 / Cache Storage',
    kind: 'necessary',
    where: { zh: '本站 · Cache Storage', en: 'This site · Cache Storage' },
    purpose: { zh: '离线时也能打开看过的页面', en: 'Lets pages you visited open offline' },
    lifetime: {
      zh: '新版本上线时替换；可在浏览器设置中清除',
      en: 'Replaced on each release; clear any time in browser settings',
    },
  },
  {
    name: 'az-theme',
    kind: 'preference',
    where: { zh: '本站 · localStorage', en: 'This site · localStorage' },
    purpose: { zh: '记住你选择的浅色 / 深色主题', en: 'Remembers your light / dark theme choice' },
    lifetime: { zh: '直到你清除', en: 'Until you clear it' },
  },
  {
    name: 'az-consent',
    kind: 'preference',
    where: { zh: '本站 · localStorage', en: 'This site · localStorage' },
    purpose: {
      zh: '记住你在「隐私选择」中的广告 / 统计 Cookie 选择',
      en: 'Remembers your ad / analytics cookie choice',
    },
    lifetime: { zh: '直到你修改或清除', en: 'Until you change or clear it' },
  },
  {
    name: 'Cloudflare Turnstile',
    kind: 'necessary',
    where: { zh: 'challenges.cloudflare.com', en: 'challenges.cloudflare.com' },
    purpose: {
      zh: '表单人机验证（只在含表单的页面加载）',
      en: 'Bot protection on forms (loaded only on form pages)',
    },
    lifetime: { zh: '由 Cloudflare 决定', en: 'Set by Cloudflare' },
  },
  {
    name: '_ga, _ga_<ID>',
    kind: 'analytics',
    where: { zh: '本站域名 · Google Analytics 4', en: 'This domain · Google Analytics 4' },
    purpose: {
      zh: '区分访客与会话，统计页面访问（仅在启用 GA4 且同意统计时设置）',
      en: 'Distinguishes visitors and sessions (only when GA4 is on and analytics is allowed)',
    },
    lifetime: { zh: '最长 2 年', en: 'Up to 2 years' },
  },
  {
    name: '__gads, __gpi, __eoi',
    kind: 'ads',
    where: { zh: '本站域名 · Google AdSense', en: 'This domain · Google AdSense' },
    purpose: {
      zh: '广告投放、频次控制与防作弊（仅在启用 AdSense 且同意广告时设置）',
      en: 'Ad delivery, frequency capping and fraud prevention (only when AdSense is on and ads are allowed)',
    },
    lifetime: { zh: '最长 13 个月', en: 'Up to 13 months' },
  },
  {
    name: 'IDE, test_cookie 等',
    kind: 'ads',
    where: { zh: 'doubleclick.net / google.com（第三方）', en: 'doubleclick.net / google.com (third party)' },
    purpose: { zh: 'Google 个性化广告与广告衡量', en: 'Google personalised ads and measurement' },
    lifetime: { zh: '由 Google 决定，最长 13 个月', en: 'Set by Google, up to 13 months' },
  },
  {
    name: 'FCCDCF, FCNEC',
    kind: 'ads',
    where: { zh: '本站域名 · Google 同意管理（隐私和消息）', en: 'This domain · Google consent management' },
    purpose: {
      zh: '保存你在 Google 同意弹窗里的选择（欧洲经济区、英国、瑞士访客）',
      en: 'Stores your answer to Google’s consent message (EEA, UK, Switzerland)',
    },
    lifetime: { zh: '最长 13 个月', en: 'Up to 13 months' },
  },
];

export const KIND_LABEL = {
  zh: { necessary: '必要', preference: '偏好', analytics: '统计', ads: '广告' },
  en: { necessary: 'Necessary', preference: 'Preference', analytics: 'Analytics', ads: 'Advertising' },
} as const;
