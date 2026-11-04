import { defineConfig, devices, type Project } from '@playwright/test';

/**
 * T9.19 设备 / 浏览器矩阵冒烟（Playwright 设备模拟，不是真机）：
 * 3 引擎（Chromium / Firefox / WebKit）× 8 个设备档（iPhone SE / iPhone 15 / Pixel 7 / iPad 竖 / iPad 横 /
 * 1024 / 1440 / 1920）× tests/devices/ 里的页面清单：横向溢出 0、导航可用、主按钮可见、无脚本错误，
 * 每格截一张首屏图（test-results/devices/，CI 产物 device-matrix-<引擎>），汇总写 test-results/devices/<引擎>.json。
 * 结果与仍需真机确认的项见 docs/DEVICE-MATRIX.md。PW_BROWSERS=webkit 只跑某个引擎；先 npm run build。
 */
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
// 本地并行多套工作区时可换端口（默认 4323，CI 不设）
const PORT = process.env.PW_DEVICES_PORT ?? '4323';

const desk = (w: number, h: number) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const DEVICES: Record<string, Record<string, unknown>> = {
  'iphone-se': devices['iPhone SE'],
  'iphone-15': devices['iPhone 15'],
  'pixel-7': devices['Pixel 7'],
  'ipad-portrait': devices['iPad (gen 7)'],
  'ipad-landscape': devices['iPad (gen 7) landscape'],
  'desktop-1024': desk(1024, 768),
  'desktop-1440': desk(1440, 900),
  'desktop-1920': desk(1920, 1080),
};

const only = process.env.PW_BROWSERS?.split(',');
const projects: Project[] = [];
for (const b of ['chromium', 'firefox', 'webkit'] as const) {
  if (only && !only.includes(b)) continue;
  for (const [name, d] of Object.entries(DEVICES)) {
    // 设备描述只取视口 / DPR / 触摸 / UA；引擎由项目决定（Firefox 不支持 isMobile）
    const { isMobile, ...rest } = { ...(d as { isMobile?: boolean; defaultBrowserType?: string }) };
    delete rest.defaultBrowserType;
    projects.push({
      name: `${b}-${name}`,
      use: {
        ...rest,
        browserName: b,
        isMobile: b === 'firefox' ? undefined : isMobile,
        ...(b !== 'webkit' && /iPhone|iPad/.test(String((rest as { userAgent?: string }).userAgent))
          ? { userAgent: undefined }
          : {}),
        launchOptions:
          b === 'chromium' && process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : undefined,
      },
    });
  }
}

export default defineConfig({
  testDir: 'tests/devices',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : process.env.CI ? 3 : 4,
  // json：首跑失败（flaky）单独报告，见 scripts/ci/flaky-report.mjs 与 docs/CI.md
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['json', { outputFile: process.env.PW_JSON_REPORT ?? 'reports/devices-results.json' }],
      ]
    : [['list']],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
  },
  projects,
  webServer: {
    command: `node scripts/serve.mjs ${PORT} dist/client`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
