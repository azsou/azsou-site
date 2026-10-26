/**
 * Lighthouse CI：性能 / 无障碍 / 最佳实践 / SEO 四项都 ≥ 95（移动端模拟、慢速 4G + 4× CPU 节流，与 docs/PLAN.md §1 的预算一致）。
 * 覆盖首页、各列表与详情模板、论坛（列表 / 主题页 / 发帖页）、搜索、登录、英文版（/en/）、订阅页、P8 原创长文与隐私政策（中英）、404。
 * 数据库主题外壳 /forum/t/?id= 不在这里：正文来自线上数据库（这里屏蔽了 Supabase 请求），只剩「加载失败」骨架，
 * 分数不代表真实体验；它与种子主题共用同一套模板与脚本（/forum/t/t-announce/ 已覆盖）。
 */
const BASE = 'http://127.0.0.1:4322';
const PAGES = [
  '/',
  '/apps/',
  '/apps/fablemotion/',
  '/ai/',
  '/ai/claude-code/',
  '/videos/',
  '/videos/designing-claude-code/',
  '/games/emberdeep/',
  '/articles/',
  '/articles/fablemotion-s3-timeline/',
  '/works/fm-motion-typography/',
  '/games/',
  '/works/',
  '/forum/',
  '/forum/t/t-announce/',
  '/forum/new/',
  '/search/',
  '/tags/',
  '/guestbook/',
  '/links/',
  '/login/',
  '/about/',
  // 中英双语（T7.6）与订阅（T7.8）
  '/en/',
  '/en/apps/fablemotion/',
  '/en/ai/claude-code/',
  '/en/videos/designing-claude-code/',
  '/en/articles/',
  '/subscribe/',
  // P8：原创长文（含文内 / 侧栏广告位预留）与法律页
  '/articles/static-site-strict-csp/',
  '/privacy/',
  '/en/privacy/',
  '/404.html',
];

// noindex 页面（发帖、搜索、登录、404）按设计不允许收录，Lighthouse 的 is-crawlable 会把 SEO 分压到 ~66；
// 这些页面只断言其余三项，SEO 由可收录的页面负责（四项 ≥ 95）。
// 论坛主题页与发帖页带交互 island：Markdown 渲染 + DOMPurify 净化 + 编辑器（含图片上传）在首屏后按需加载，
// 首屏关键 JS 仍 ≤ 50 KB（npm run size 按页面检查）；这里把「页面加载期间的全部脚本」预算放宽到 72 KB。
// T9.21 收紧（2026-10-26，按 4acea4d 的 CI 实测中位数 + 余量）：最差 LCP 1714ms → 上限 1900；最差 CLS 0.0087 → 0.02（DoD D10）；
// 最差 TBT 13.5ms → 100 且改为阻断；非 island 页脚本最大 43.4 KB → 48 KB；island 页 65.2 KB → 72 KB；整页传输最大 287 KB → 350 KB 且改为阻断。
const BASE_ASSERTIONS = {
  'categories:performance': ['error', { minScore: 0.95 }],
  'categories:accessibility': ['error', { minScore: 0.95 }],
  'categories:best-practices': ['error', { minScore: 0.95 }],
  'categories:seo': ['error', { minScore: 0.95 }],
  'largest-contentful-paint': ['error', { maxNumericValue: 1900 }],
  'cumulative-layout-shift': ['error', { maxNumericValue: 0.02 }],
  'total-blocking-time': ['error', { maxNumericValue: 100 }],
  'resource-summary:script:size': ['error', { maxNumericValue: 49152 }],
  'resource-summary:total:size': ['error', { maxNumericValue: 358400 }],
};
const ISLAND_JS = { 'resource-summary:script:size': ['error', { maxNumericValue: 73728 }] };
const NO_SEO = { 'categories:seo': 'off' };
const GROUPS = [
  ['/forum/t/[^/]+/', ISLAND_JS],
  ['/forum/new/', { ...ISLAND_JS, ...NO_SEO }],
  ['/(search/|login/|404\\.html)', NO_SEO],
];
const anyGroup = GROUPS.map(([p]) => p).join('|');
const matrix = [
  ...GROUPS.map(([p, extra]) => ({
    matchingUrlPattern: `^https?://[^/]+(${p})$`,
    aggregationMethod: 'median',
    assertions: { ...BASE_ASSERTIONS, ...extra },
  })),
  {
    matchingUrlPattern: `^https?://[^/]+(?!(${anyGroup})$)/.*$`,
    aggregationMethod: 'median',
    assertions: BASE_ASSERTIONS,
  },
];

module.exports = {
  ci: {
    collect: {
      startServerCommand: 'node scripts/serve.mjs 4322 dist/client',
      startServerReadyPattern: 'serving',
      url: PAGES.map((p) => BASE + p),
      // 每页 3 次取中位数，减少 CI 机器抖动导致的偶发失败
      numberOfRuns: 3,
      settings: {
        formFactor: 'mobile',
        chromeFlags: '--no-sandbox --headless=new',
        // 线上数据岛请求不计入预算（P1 只读）
        blockedUrlPatterns: ['*supabase.co*'],
        // 整页截图会把视口撑到整页高度，触发首屏以下 island（评价 / 评论，whenNear）的懒加载，
        // 让这些脚本偶尔被算进「页面加载期间的脚本」预算（/ai/claude-code/ 51.3 KB vs 正常 43 KB）。真实访客不滚动不会加载。
        disableFullPageScreenshot: true,
      },
    },
    assert: { assertMatrix: matrix },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
