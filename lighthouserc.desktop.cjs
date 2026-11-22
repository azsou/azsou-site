/**
 * Lighthouse CI 桌面档（T9.21，DoD D10「移动 + 桌面」）：preset desktop（1350×940、无 CPU 节流、有线网络），
 * 每类模板一个代表页，每页 1 次（桌面分数抖动小；移动档 lighthouserc.cjs 每页 3 次取中位数）。
 * 四项 ≥ 95；LCP ≤ 1500ms、CLS ≤ 0.02、TBT ≤ 100ms。noindex 页（搜索 / 登录）不断言 SEO。
 */
const BASE = 'http://127.0.0.1:4324';
const PAGES = [
  '/',
  '/apps/',
  '/apps/fablemotion/',
  '/ai/',
  '/ai/claude-code/',
  '/articles/static-site-strict-csp/',
  '/videos/designing-claude-code/',
  '/games/emberdeep/',
  '/forum/',
  '/en/',
  '/search/',
  '/login/',
];
const BASE_ASSERTIONS = {
  'categories:performance': ['error', { minScore: 0.95 }],
  'categories:accessibility': ['error', { minScore: 0.95 }],
  'categories:best-practices': ['error', { minScore: 0.95 }],
  'categories:seo': ['error', { minScore: 0.95 }],
  'largest-contentful-paint': ['error', { maxNumericValue: 1500 }],
  'cumulative-layout-shift': ['error', { maxNumericValue: 0.02 }],
  'total-blocking-time': ['error', { maxNumericValue: 100 }],
};
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'node scripts/serve.mjs 4324 dist/client',
      startServerReadyPattern: 'serving',
      url: PAGES.map((p) => BASE + p),
      numberOfRuns: 1,
      settings: {
        preset: 'desktop',
        chromeFlags: '--no-sandbox --headless=new',
        blockedUrlPatterns: ['*supabase.co*'],
        disableFullPageScreenshot: true,
      },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: '^https?://[^/]+/(search|login)/$',
          assertions: { ...BASE_ASSERTIONS, 'categories:seo': 'off' },
        },
        { matchingUrlPattern: '^https?://[^/]+(?!/(search|login)/$)/.*$', assertions: BASE_ASSERTIONS },
      ],
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci-desktop' },
  },
};
