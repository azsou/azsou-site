import { defineConfig, devices } from '@playwright/test';

/**
 * 设计门禁（T9.2）：Chromium 单引擎。
 *  - design：Q5 / Q8 / Q11 / Q12 / Q18 断言（tests/design/）
 *  - visual：Q2 视觉回归（tests/visual/，基线在 CI 同款 ubuntu + fonts-noto-cjk 中生成后提交）
 * 先 npm run build；本地 Linux arm64 用 CHROMIUM_PATH 指向系统 Chromium。
 */
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
// 本地并行多套工作区时可换端口（默认 4322，CI 不设）
const PORT = process.env.PW_DESIGN_PORT ?? '4322';

const chromium = {
  ...devices['Desktop Chrome'],
  deviceScaleFactor: 1,
  launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
};

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : process.env.CI ? 3 : 4,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-design' }]]
    : [['list']],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.15, animations: 'disabled' },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'design', testDir: 'tests/design', use: chromium },
    { name: 'visual', testDir: 'tests/visual', use: chromium },
  ],
  webServer: {
    command: `node scripts/serve.mjs ${PORT} dist/client`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
