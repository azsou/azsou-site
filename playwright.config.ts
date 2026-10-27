import { defineConfig, devices, type Project } from '@playwright/test';
// 端口：PW_PORT → E2E_PORT → 4321（与自建 context 的用例共用，tests/e2e/port.ts）
import { BASE_URL, PORT } from './tests/e2e/port';

/**
 * 3 引擎 × 4 视口 = 12 个项目。
 *  - chromium / firefox / webkit（≈ Safari）
 *  - desktop 1440、tablet 834（iPad）、iphone 390、android 360
 * PW_BROWSERS=webkit 只跑某个引擎；CHROMIUM_PATH 在 Playwright 没有 Chromium 构建的平台（如 Linux arm64）指向系统 Chromium。
 */

// 本地测试服务器不走代理（沙箱/公司网络常设 HTTP_PROXY）
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, mobile: false },
  tablet: { viewport: { width: 834, height: 1194 }, mobile: true },
  iphone: { viewport: { width: 390, height: 844 }, mobile: true },
  android: { viewport: { width: 360, height: 800 }, mobile: true },
} as const;

const BROWSERS = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
} as const;

const only = process.env.PW_BROWSERS?.split(',');
const projects: Project[] = [];
for (const [b, base] of Object.entries(BROWSERS)) {
  if (only && !only.includes(b)) continue;
  for (const [v, cfg] of Object.entries(VIEWPORTS)) {
    projects.push({
      name: `${b}-${v}`,
      use: {
        ...base,
        viewport: cfg.viewport,
        deviceScaleFactor: cfg.mobile && b !== 'firefox' ? 2 : 1,
        hasTouch: cfg.mobile,
        // Firefox 不支持 isMobile
        isMobile: cfg.mobile && b !== 'firefox',
        launchOptions:
          b === 'chromium' && process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : undefined,
      },
    });
  }
}

export default defineConfig({
  testDir: 'tests/e2e',
  // 社区（P3）用例的真实后端：本地 Postgres + PostgREST（未配置时这些用例跳过）
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : process.env.CI ? 2 : undefined,
  // CI 也加 list：日志里逐条列出跑了哪些用例（确认用例实际执行而非跳过）
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    // Service Worker 会让 WebKit/Firefox 绕过 page.route 的假数据；只有 PWA 用例单独放开
    serviceWorkers: 'block',
  },
  projects,
  webServer: {
    command: `node scripts/serve.mjs ${PORT} dist/client`,
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
