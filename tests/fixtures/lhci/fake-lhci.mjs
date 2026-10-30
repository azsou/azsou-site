#!/usr/bin/env node
// 测试用假 lhci（tests/unit/lhci-tier.test.ts）：不启动浏览器。
//   collect：读 --config 的 ci.collect.url 与 numberOfRuns，在 .lighthouseci/ 为每页每次写一个 lhr-*.json（FAKE_URLS 逗号分隔可覆盖页面），
//            退出码 FAKE_COLLECT_RC。故障开关：
//              FAKE_DROP=<n>           少写最后 n 个样本（样本不足）
//              FAKE_RUNTIME_ERROR=1    第一个 LHR 带 runtimeError、指标为空（Lighthouse 跑崩）
//              FAKE_MISSING_METRIC=1   第一个 LHR 缺 LCP
//              FAKE_SABOTAGE=copy|summary|manifest|exitcodes  在 FAKE_OUT（本档输出目录）里预先放一个同名目录，制造真实的文件系统写入失败：
//                copy      → raw/ 里与 LHR 同名的目录，cp 只能复制一部分并报错
//                summary   → summary.json 是目录，摘要写不进去
//                manifest  → manifest.sha256 是目录，清单改名失败
//                exitcodes → exit-codes.json 是目录，退出码记录写不进去
//   assert ：写 .lighthouseci/assertion-results.json（FAKE_NO_ASSERT_FILE=1 时不写），退出码 FAKE_ASSERT_RC（非 0 时写一条未通过）
//   upload ：在 --outputDir 写 manifest.json（每个 LHR 一条），退出码 FAKE_UPLOAD_RC
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cmd, ...args] = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const rc = (k) => Number(process.env[k] ?? 0);
const env = process.env;

function config() {
  const p = resolve(opt('config'));
  if (!existsSync(p)) return { urls: ['http://127.0.0.1:1/'], runs: 1 };
  const c = createRequire(pathToFileURL(p).href)(p).ci.collect;
  return { urls: c.url, runs: c.numberOfRuns ?? 1 };
}
const lhr = (u, i, cls) => ({
  requestedUrl: u,
  fetchTime: new Date().toISOString(),
  lighthouseVersion: '12.6.1',
  audits: {
    'largest-contentful-paint': { numericValue: 400 },
    'cumulative-layout-shift': { numericValue: cls },
    'total-blocking-time': { numericValue: 0 },
    'resource-summary': {
      details: {
        items: [
          { resourceType: 'total', transferSize: 100000 },
          { resourceType: 'script', transferSize: 20000 },
        ],
      },
    },
  },
  categories: {
    performance: { score: 1 },
    accessibility: { score: 1 },
    'best-practices': { score: 1 },
    seo: { score: 1 },
  },
  _i: i,
});

if (cmd === 'collect') {
  const c = config();
  const urls = env.FAKE_URLS ? env.FAKE_URLS.split(',') : c.urls;
  mkdirSync('.lighthouseci', { recursive: true });
  let samples = [];
  urls.forEach((u) => {
    for (let r = 0; r < c.runs; r++) samples.push(u);
  });
  samples = samples.slice(0, samples.length - Number(env.FAKE_DROP ?? 0));
  samples.forEach((u, i) => {
    const l = lhr(u, i, Number(env.FAKE_CLS ?? 0));
    if (i === 0 && env.FAKE_RUNTIME_ERROR) {
      l.runtimeError = { code: 'NO_FCP', message: 'fake' };
      l.audits['largest-contentful-paint'] = { numericValue: null };
      l.categories.performance.score = null;
    }
    if (i === 0 && env.FAKE_MISSING_METRIC) delete l.audits['largest-contentful-paint'];
    writeFileSync(join('.lighthouseci', `lhr-${String(i).padStart(4, '0')}.json`), JSON.stringify(l));
  });
  const out = env.FAKE_OUT;
  if (out && env.FAKE_SABOTAGE) {
    const target = {
      copy: join(out, 'raw', 'lhr-0001.json'),
      summary: join(out, 'summary.json'),
      manifest: join(out, 'manifest.sha256'),
      exitcodes: join(out, 'exit-codes.json'),
    }[env.FAKE_SABOTAGE];
    mkdirSync(join(target, 'blocker'), { recursive: true });
  }
  process.exit(rc('FAKE_COLLECT_RC'));
}
if (cmd === 'assert') {
  const failed = rc('FAKE_ASSERT_RC') !== 0;
  if (!env.FAKE_NO_ASSERT_FILE)
    writeFileSync(
      join('.lighthouseci', 'assertion-results.json'),
      JSON.stringify(
        failed
          ? [
              {
                url: config().urls[0],
                auditId: 'cumulative-layout-shift',
                level: 'error',
                passed: false,
                actual: 0.08,
                expected: 0.02,
                operator: '<=',
              },
            ]
          : [],
      ),
    );
  process.exit(rc('FAKE_ASSERT_RC'));
}
if (cmd === 'upload') {
  const d = opt('outputDir');
  mkdirSync(d, { recursive: true });
  const lhrs = readdirSync('.lighthouseci').filter((f) => /^lhr-.*\.json$/.test(f));
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(lhrs.map((f) => ({ jsonPath: f }))));
  process.exit(rc('FAKE_UPLOAD_RC'));
}
process.exit(99);
