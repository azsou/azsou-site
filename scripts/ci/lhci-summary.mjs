#!/usr/bin/env node
/**
 * Lighthouse 一档的摘要：读 <档目录>/raw/lhr-*.json 与 raw/assertion-results.json，
 * 写 <档目录>/summary.json 与 summary.md。只读原始数据，不改任何文件。
 *   node scripts/ci/lhci-summary.mjs lhci-out/mobile
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export function runFromLhr(lhr, file) {
  const a = lhr.audits ?? {};
  const items = a['resource-summary']?.details?.items ?? [];
  const size = (t) => items.find((i) => i.resourceType === t)?.transferSize ?? null;
  const cat = (k) => lhr.categories?.[k]?.score ?? null;
  return {
    file,
    url: lhr.requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? null,
    fetchTime: lhr.fetchTime ?? null,
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    userAgent: lhr.environment?.hostUserAgent ?? null,
    formFactor: lhr.configSettings?.formFactor ?? null,
    runtimeError: lhr.runtimeError?.code ?? null,
    lcp: a['largest-contentful-paint']?.numericValue ?? null,
    cls: a['cumulative-layout-shift']?.numericValue ?? null,
    tbt: a['total-blocking-time']?.numericValue ?? null,
    script: size('script'),
    total: size('total'),
    performance: cat('performance'),
    accessibility: cat('accessibility'),
    bestPractices: cat('best-practices'),
    seo: cat('seo'),
  };
}

export function summarize(dir) {
  const raw = join(dir, 'raw');
  const files = existsSync(raw)
    ? readdirSync(raw)
        .filter((f) => /^lhr-.*\.json$/.test(f))
        .sort()
    : [];
  const runs = files.map((f) => runFromLhr(JSON.parse(readFileSync(join(raw, f), 'utf8')), f));
  const byUrl = new Map();
  for (const r of runs) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  const pages = [...byUrl].map(([url, rs]) => ({
    url,
    runs: rs.length,
    median: Object.fromEntries(
      ['lcp', 'cls', 'tbt', 'script', 'total', 'performance', 'accessibility', 'bestPractices', 'seo'].map(
        (k) => [k, median(rs.map((r) => r[k]))],
      ),
    ),
    max: { cls: Math.max(...rs.map((r) => r.cls ?? 0)), tbt: Math.max(...rs.map((r) => r.tbt ?? 0)) },
  }));
  const arPath = join(raw, 'assertion-results.json');
  const assertions = existsSync(arPath) ? JSON.parse(readFileSync(arPath, 'utf8')) : null;
  const failed = (assertions ?? []).filter((x) => !x.passed);
  let exitCodes = null;
  try {
    exitCodes = JSON.parse(readFileSync(join(dir, 'exit-codes.json'), 'utf8'));
  } catch {
    /* 没有就记 null */
  }
  return {
    dir,
    exitCodes,
    lhrCount: runs.length,
    urlCount: pages.length,
    assertionResultsPresent: assertions !== null,
    assertionCount: assertions?.length ?? null,
    failedAssertions: failed,
    pages,
    runs,
  };
}

function toMd(s) {
  const f = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
  const lines = [
    `### Lighthouse ${s.exitCodes?.tier ?? s.dir}：${s.exitCodes?.status ?? '?'}`,
    '',
    `collect=${s.exitCodes?.collect} · assert=${s.exitCodes?.assert} · upload=${s.exitCodes?.upload} · LHR ${s.lhrCount} 次 / ${s.urlCount} 页 · 未通过断言 ${s.failedAssertions.length}`,
    '',
    '| 页面 | 次数 | LCP 中位 ms | CLS 中位 | CLS 最大 | TBT 中位 ms | TBT 最大 ms | 脚本 B | 性能 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...s.pages.map(
      (p) =>
        `| ${p.url.replace(/^https?:\/\/[^/]+/, '')} | ${p.runs} | ${f(p.median.lcp)} | ${f(p.median.cls, 4)} | ${f(p.max.cls, 4)} | ${f(p.median.tbt)} | ${f(p.max.tbt)} | ${f(p.median.script)} | ${f(p.median.performance, 2)} |`,
    ),
    '',
    ...s.failedAssertions.map(
      (x) =>
        `- ✗ ${x.url} ${x.auditId}${x.name ? `.${x.name}` : ''}：实际 ${x.actual} ${x.operator ?? ''} 期望 ${x.expected}`,
    ),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法：lhci-summary.mjs <档目录>');
    process.exit(2);
  }
  const s = summarize(dir);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
  writeFileSync(join(dir, 'summary.md'), toMd(s));
  console.log(`summary：${s.lhrCount} 次 LHR / ${s.urlCount} 页，未通过断言 ${s.failedAssertions.length}`);
}
