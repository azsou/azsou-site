#!/usr/bin/env node
/**
 * Lighthouse 一档的摘要：读 <档目录>/raw/lhr-*.json 与 raw/assertion-results.json，
 * 写 <档目录>/summary.json 与 summary.md。只读原始数据，不改原始文件。
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

export function summarize(dir, steps = null) {
  const raw = join(dir, 'raw');
  const files = existsSync(raw)
    ? readdirSync(raw)
        .filter((f) => /^lhr-.*\.json$/.test(f))
        .sort()
    : [];
  // 解析失败的 LHR 不丢弃、不报异常退出：逐个记进 unparseableLhr（完整性由 lhci-verify.mjs 判失败）
  const runs = [];
  const unparseableLhr = [];
  for (const f of files) {
    try {
      runs.push(runFromLhr(JSON.parse(readFileSync(join(raw, f), 'utf8')), f));
    } catch {
      unparseableLhr.push(f);
    }
  }
  const byUrl = new Map();
  for (const r of runs) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r]);
  // 聚合方式不变（中位数）。注意：中位数会跳过非数值，所以 runtimeError / 缺指标的样本在这里看不出来，
  // 证据是否完整只看 lhci-verify.mjs，不看这张表。
  const pages = [...byUrl].map(([url, rs]) => ({
    url,
    runs: rs.length,
    runtimeErrors: rs.filter((r) => r.runtimeError).length,
    median: Object.fromEntries(
      ['lcp', 'cls', 'tbt', 'script', 'total', 'performance', 'accessibility', 'bestPractices', 'seo'].map(
        (k) => [k, median(rs.map((r) => r[k]))],
      ),
    ),
    max: { cls: Math.max(...rs.map((r) => r.cls ?? 0)), tbt: Math.max(...rs.map((r) => r.tbt ?? 0)) },
  }));
  const arPath = join(raw, 'assertion-results.json');
  let assertions = null;
  let assertionResults = 'missing';
  if (existsSync(arPath)) {
    try {
      const v = JSON.parse(readFileSync(arPath, 'utf8'));
      if (Array.isArray(v)) {
        assertions = v;
        assertionResults = v.length ? 'present' : 'present-empty';
      } else assertionResults = 'not-array';
    } catch {
      assertionResults = 'unparseable';
    }
  }
  const failed = (assertions ?? []).filter((x) => !x.passed);
  return {
    dir,
    // lhci-tier.sh 在写摘要时已知的各步退出码（collect / assert / archive / upload / cleanup）；最终结论只看 exit-codes.json
    steps,
    lhrCount: files.length,
    parsedLhrCount: runs.length,
    unparseableLhr,
    urlCount: pages.length,
    // missing / unparseable / not-array / present-empty（合法的 []）/ present
    assertionResults,
    assertionResultsPresent: assertions !== null,
    // LHCI 的 assertion-results.json 只列未通过（含 warn 级）的断言，这是条目数，不是执行过的断言总数
    failedOrWarnAssertionEntries: assertions ? assertions.length : null,
    failedAssertions: failed,
    pages,
    runs,
  };
}

function toMd(s) {
  const f = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
  const lines = [
    `### Lighthouse ${s.dir}（原始数据摘要；本档结论见 exit-codes.json）`,
    '',
    `${Object.entries(s.steps ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(
        ' · ',
      )} · LHR ${s.lhrCount} 个（可解析 ${s.parsedLhrCount}）/ ${s.urlCount} 页 · assertion-results=${s.assertionResults} · 未通过/警告条目 ${s.failedOrWarnAssertionEntries ?? '—'}`,
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
  const parseSteps = (v) => {
    if (!v) return null;
    try {
      return JSON.parse(v);
    } catch {
      return { invalid: v };
    }
  };
  const steps = parseSteps(process.env.LHCI_STEPS);
  const s = summarize(dir, steps);
  // 写失败直接抛错 → 非 0 退出，lhci-tier.sh 记 summary 失败
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
  writeFileSync(join(dir, 'summary.md'), toMd(s));
  console.log(
    `summary：LHR ${s.lhrCount} 个 / ${s.urlCount} 页，assertion-results=${s.assertionResults}，未通过/警告条目 ${s.failedOrWarnAssertionEntries ?? '—'}`,
  );
}
