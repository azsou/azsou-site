#!/usr/bin/env node
// 测试用假 lhci（tests/unit/lhci-tier.test.ts）：不启动浏览器。
//   collect：在 .lighthouseci/ 写 FAKE_URLS（逗号分隔）各一个 lhr-*.json，退出码 FAKE_COLLECT_RC
//   assert ：写 .lighthouseci/assertion-results.json，退出码 FAKE_ASSERT_RC（非 0 时写一条未通过）
//   upload ：在 --outputDir 写 manifest.json，退出码 FAKE_UPLOAD_RC
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [cmd, ...args] = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const rc = (k) => Number(process.env[k] ?? 0);
const urls = (process.env.FAKE_URLS ?? 'http://127.0.0.1:1/').split(',');
if (cmd === 'collect') {
  mkdirSync('.lighthouseci', { recursive: true });
  urls.forEach((u, i) =>
    writeFileSync(
      join('.lighthouseci', `lhr-${Date.now()}${i}.json`),
      JSON.stringify({
        requestedUrl: u,
        fetchTime: new Date().toISOString(),
        audits: {
          'largest-contentful-paint': { numericValue: 400 },
          'cumulative-layout-shift': { numericValue: Number(process.env.FAKE_CLS ?? 0) },
          'total-blocking-time': { numericValue: 0 },
        },
        categories: { performance: { score: 1 } },
      }),
    ),
  );
  process.exit(rc('FAKE_COLLECT_RC'));
}
if (cmd === 'assert') {
  const failed = rc('FAKE_ASSERT_RC') !== 0;
  writeFileSync(
    join('.lighthouseci', 'assertion-results.json'),
    JSON.stringify(
      failed
        ? [
            {
              url: urls[0],
              auditId: 'cumulative-layout-shift',
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
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(urls.map((url) => ({ url }))));
  process.exit(rc('FAKE_UPLOAD_RC'));
}
process.exit(99);
