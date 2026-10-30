#!/usr/bin/env node
/**
 * 记录 Lighthouse 一档的采集环境（r18），写到 stdout（lhci-tier.sh 重定向到 <档目录>/env.json）。只读，不安装、不改任何东西。
 * 宿主（runner 的操作系统 / CPU / 内存 / Node / 字体 / 浏览器）与页面模拟（formFactor、屏幕、模拟 UA）分开：
 * 页面模拟以每个 LHR 的 configSettings 为准（lhci-evidence.mjs 逐样本记录），这里只记宿主。
 * 浏览器路径用固定版本 @lhci/cli 自己的选择逻辑（src/utils.js determineChromePath：--chromePath → CHROME_PATH → puppeteer（未用）→
 * chrome-launcher getInstallations()[0]）算出，这正是 LHCI collect 传给 Lighthouse 子进程的 CHROME_PATH；
 * lhci-evidence.mjs 再用每次尝试实际收到的 CHROME_PATH 复核。
 * 只输出白名单字段：不输出任何令牌、凭据或环境变量全集。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PIN = resolve(here, '../../tools/lhci/node_modules');
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim();
  } catch {
    return null;
  }
};
const ver = (p) => {
  try {
    return JSON.parse(readFileSync(join(PIN, p, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};
const problems = [];
let browserPath = null;
try {
  const req = createRequire(join(PIN, '@lhci/cli/package.json'));
  browserPath = req('@lhci/cli/src/utils.js').determineChromePath({}) ?? null;
} catch (e) {
  problems.push(`算不出 LHCI 选用的浏览器路径：${e?.message ?? e}`);
}
const browserVersion = browserPath ? run(browserPath, ['--version']) : null;
if (!browserPath) problems.push('LHCI 没有找到浏览器');
else if (!browserVersion) problems.push(`读不出浏览器版本：${browserPath}`);
const osRelease = existsSync('/etc/os-release')
  ? Object.fromEntries(
      readFileSync('/etc/os-release', 'utf8')
        .split('\n')
        .map((l) => /^(PRETTY_NAME|VERSION_ID)="?([^"]*)"?$/.exec(l))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    )
  : null;
const fc = run('fc-list', []);
const fcZh = run('fc-list', [':lang=zh']);
const out = {
  schema: 'az-lhci-env/1',
  recordedAt: new Date().toISOString(),
  host: {
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    platform: os.platform(),
    release: os.release(),
    osRelease,
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    memMiB: Math.round(os.totalmem() / 1048576),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    node: process.version,
  },
  tools: {
    lhciCli: ver('@lhci/cli'),
    lhciUtils: ver('@lhci/utils'),
    lighthouse: ver('lighthouse'),
    chromeLauncherUsedByLhci: ver('chrome-launcher'),
    chromeLauncherUsedByLighthouse: ver('lighthouse/node_modules/chrome-launcher') ?? ver('chrome-launcher'),
  },
  browser: {
    path: browserPath,
    version: browserVersion,
    chromePathEnv: process.env.CHROME_PATH || null,
  },
  fonts: fc === null ? null : {
    entries: fc ? fc.split('\n').length : 0,
    sha256Sorted: createHash('sha256').update(fc.split('\n').sort().join('\n')).digest('hex'),
    zhEntries: fcZh ? fcZh.split('\n').filter(Boolean).length : 0,
  },
  github: {
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
  },
  problems,
};
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
process.exit(problems.length ? 1 : 0);
