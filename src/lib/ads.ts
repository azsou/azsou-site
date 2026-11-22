/**
 * 变现与 Google 标签配置（P8：AdSense / GA4 / Search Console）。
 *
 * 全部由构建期环境变量控制，默认全关：没设变量时不输出任何 Google 脚本、广告位、ads.txt，也不放开 CSP。
 *  - PUBLIC_ADSENSE_CLIENT        ca-pub-<16 位数字>；设了才有 ads.txt 与 AdSense 加载器
 *  - PUBLIC_ADSENSE_SLOT_ARTICLE  文内广告单元 ID（10 位左右数字，AdSense 后台「按广告单元」创建）
 *  - PUBLIC_ADSENSE_SLOT_SIDEBAR  侧栏广告单元 ID
 *  - PUBLIC_ADSENSE_SLOT_LIST     列表间广告单元 ID
 *    某个位置没填单元 ID → 该位置不出广告（不会退化成自动广告）
 *  - PUBLIC_GA4_ID                G-XXXXXXX；设了才加载 gtag.js（受 Consent Mode v2 约束）
 *  - PUBLIC_GSC_VERIFICATION      Search Console「HTML 标记」验证码（只输出 meta，不加载脚本）
 *
 * 纯函数、不读 import.meta：Astro 组件传 import.meta.env，Node 脚本与单元测试传 process.env / 假数据。
 */

export interface GoogleEnv {
  PUBLIC_ADSENSE_CLIENT?: string;
  PUBLIC_ADSENSE_SLOT_ARTICLE?: string;
  PUBLIC_ADSENSE_SLOT_SIDEBAR?: string;
  PUBLIC_ADSENSE_SLOT_LIST?: string;
  PUBLIC_GA4_ID?: string;
  PUBLIC_GSC_VERIFICATION?: string;
}

export type AdPlacement = 'article' | 'sidebar' | 'list';

const CLIENT_RE = /^ca-pub-\d{16}$/;
const SLOT_RE = /^\d{6,12}$/;
const GA4_RE = /^G-[A-Z0-9]{4,12}$/;
const GSC_RE = /^[A-Za-z0-9_-]{10,100}$/;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** 合法的 AdSense 客户端 ID（ca-pub-…），否则 null。格式不对时宁可关掉，也不输出坏代码 */
export function adsenseClient(env: GoogleEnv): string | null {
  const v = clean(env.PUBLIC_ADSENSE_CLIENT);
  return CLIENT_RE.test(v) ? v : null;
}

/** ads.txt 用的发布商 ID：ca-pub-123 → pub-123 */
export function publisherId(client: string): string {
  return client.replace(/^ca-/, '');
}

/** IAB ads.txt：只有 Google 一行（DIRECT，f08c47fec0942fa0 是 Google 的 TAG-ID）。未启用 → null（不生成文件） */
export function adsTxt(env: GoogleEnv): string | null {
  const c = adsenseClient(env);
  return c ? `google.com, ${publisherId(c)}, DIRECT, f08c47fec0942fa0\n` : null;
}

export function adSlotId(env: GoogleEnv, placement: AdPlacement): string | null {
  const key = {
    article: 'PUBLIC_ADSENSE_SLOT_ARTICLE',
    sidebar: 'PUBLIC_ADSENSE_SLOT_SIDEBAR',
    list: 'PUBLIC_ADSENSE_SLOT_LIST',
  }[placement] as keyof GoogleEnv;
  const v = clean(env[key]);
  return SLOT_RE.test(v) ? v : null;
}

export function ga4Id(env: GoogleEnv): string | null {
  const v = clean(env.PUBLIC_GA4_ID);
  return GA4_RE.test(v) ? v : null;
}

export function gscVerification(env: GoogleEnv): string | null {
  const v = clean(env.PUBLIC_GSC_VERIFICATION);
  return GSC_RE.test(v) ? v : null;
}

/**
 * 不出广告（也不加载 AdSense 脚本）的页面：后台、登录注册、CMS、写作 / 表单页、订阅、404、法律与说明页、
 * 搜索与个人页。AdSense 政策不允许广告出现在没有发布商内容的页面（登录、确认、错误页等），
 * 法律页放广告也会影响审核观感。英文页按同一规则（去掉 /en 前缀后匹配）。
 */
export const AD_FREE_PREFIXES = [
  '/admin/',
  '/cms/',
  '/api/',
  '/auth/',
  '/login/',
  '/register/',
  '/reset-password/',
  '/settings/',
  '/notifications/',
  '/bookmarks/',
  '/u/',
  '/forum/new/',
  '/guestbook/',
  '/links/',
  '/subscribe/',
  '/search/',
  '/offline/',
  '/404/',
  '/go/',
  '/privacy/',
  '/cookies/',
  '/terms/',
  '/ad-disclosure/',
  '/editorial/',
  '/about/',
  '/contact/',
];

export function adsAllowedOn(path: string): boolean {
  const p = (path.replace(/^\/en(?=\/|$)/, '') || '/').replace(/\/?$/, '/');
  // 首页是导航页（应用 / 工具入口与按钮密集），不放广告
  if (p === '/' || p === '/404.html/') return false;
  return !AD_FREE_PREFIXES.some((x) => p.startsWith(x));
}

/** GA4 不在后台 / CMS / 认证回调页加载（那里没有可统计的公开内容，也避免把令牌类 URL 发给第三方） */
export function analyticsAllowedOn(path: string): boolean {
  const p = path.replace(/^\/en(?=\/|$)/, '') || '/';
  return ![
    '/admin/',
    '/cms/',
    '/api/',
    '/auth/',
    '/reset-password/',
    '/subscribe/confirm/',
    '/subscribe/unsubscribe/',
  ].some((x) => p.startsWith(x));
}

/**
 * 文章正文至少多少字才出广告（中文按字符计，去掉标签与空白）。短文不放广告：
 * AdSense「价值不高的内容」是最常见的拒审原因，广告比内容多的页面会拉低整站评价。
 */
export const MIN_AD_ARTICLE_CHARS = 1500;

export function textLength(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, 'x')
    .replace(/\s+/g, '').length;
}

/**
 * 把文章 HTML 在合适位置一分为二，用来插入文内广告：放在第 2 个二级标题之前（前面至少已有约 600 字），
 * 找不到就放在正文中间那个段落之后。返回 null = 不插（文章太短，或切点附近有下载 / 跳转按钮）。
 */
export function splitForInArticleAd(html: string): [string, string] | null {
  if (textLength(html) < MIN_AD_ARTICLE_CHARS) return null;
  const h2s = [...html.matchAll(/<h2\b/g)].map((m) => m.index ?? 0);
  let cut = -1;
  for (const i of h2s)
    if (textLength(html.slice(0, i)) >= 600) {
      cut = i;
      break;
    }
  if (cut < 0) {
    const ps = [...html.matchAll(/<\/p>/g)].map((m) => (m.index ?? 0) + 4);
    cut = ps.find((i) => textLength(html.slice(0, i)) >= textLength(html) / 2) ?? -1;
  }
  if (cut <= 0 || cut >= html.length) return null;
  // 切点前后各一段之内不能有按钮式链接（下载 / 跳转），保证广告与按钮之间至少隔一整段正文
  const near = html.slice(Math.max(0, cut - 400), cut + 400);
  if (/class="[^"]*\bbtn\b|href="\/go\//.test(near)) return null;
  return [html.slice(0, cut), html.slice(cut)];
}

/* CSP 的 Google 来源与开关逻辑放在 scripts/google-csp.mjs（Node 脚本 check-csp / csp-google 与这里共用） */
export {
  GOOGLE_CSP,
  applyGoogleCsp,
  googleCspSources,
  googleCspState,
  isGoogleSource,
} from '../../scripts/google-csp.mjs';
