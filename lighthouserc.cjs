/** Lighthouse CI：性能 / 无障碍 / 最佳实践 / SEO 预算（移动端模拟，与 docs/PLAN.md §1 的预算一致） */
const BASE = 'http://127.0.0.1:4322';
const PAGES = [
  '/',
  '/apps/',
  '/apps/fablemotion/',
  '/games/emberdeep/',
  '/articles/',
  '/articles/fablemotion-s3-timeline/',
  '/works/fm-motion-typography/',
  '/forum/',
  '/about/',
];

module.exports = {
  ci: {
    collect: {
      startServerCommand: 'node scripts/serve.mjs 4322 dist',
      startServerReadyPattern: 'serving',
      url: PAGES.map((p) => BASE + p),
      numberOfRuns: 1,
      settings: {
        formFactor: 'mobile',
        chromeFlags: '--no-sandbox --headless=new',
        // 线上数据岛请求不计入预算（P1 只读）
        blockedUrlPatterns: ['*supabase.co*'],
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.95 }],
        'categories:seo': ['error', { minScore: 0.95 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2000 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.05 }],
        'total-blocking-time': ['warn', { maxNumericValue: 150 }],
        'resource-summary:script:size': ['error', { maxNumericValue: 51200 }],
        'resource-summary:total:size': ['warn', { maxNumericValue: 512000 }],
      },
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
