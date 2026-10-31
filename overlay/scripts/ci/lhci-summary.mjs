#!/usr/bin/env node
/**
 * Lighthouse 一档的摘要：读 <档目录>/raw/lhr-*.json 与 raw/assertion-results.json，
 * 写 <档目录>/summary.json 与 summary.md。只读原始数据，不改原始文件。
 *   node scripts/ci/lhci-summary.mjs lhci-out/mobile
 *
 * （r25，只改不完整样本的显示与计数；原始 LHR、预算、断言、聚合方式、分母都不变）
 * 档目录里有 evidence-map.json（证据模式，lhci-tier.sh 先生成对应表再写摘要）时，每页的计划 / 有效 / 失败 / 未尝试 / 证据不完整数
 * 按「计划样本 ↔ 证据」对应表计算（不是只数 raw 里成功的 LHR），没有任何有效 LHR 的计划页面也列出来。
 * 有效数 < 计划数的页面：主表标「不完整，不满足原定聚合条件」，不给中位数 / 最大值（summary.json 里 median、max 为 null，
 * aggregation = "incomplete"），不会把 2 个值的中位数当成 3 次验收；该页每个计划样本的逐次原始值另列为观测数据（不作验收、不聚合）。
 * 没有 evidence-map.json（非证据模式）时输出与原来完全相同。
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
  // r25：按计划样本 ↔ 证据对应表计每页样本数（只在证据模式下有 evidence-map.json）
  const emPath = join(dir, 'evidence-map.json');
  let slotView = null;
  if (existsSync(emPath)) {
    let em = null;
    try {
      em = JSON.parse(readFileSync(emPath, 'utf8'));
    } catch {
      em = null;
    }
    slotView = { evidenceMap: em && Array.isArray(em.samples) ? 'present' : 'unparseable', planned: em?.planned ?? null, status: em?.status ?? null };
    if (slotView.evidenceMap === 'present') {
      const runByFile = new Map(runs.map((r) => [r.file, r]));
      const order = [];
      const per = new Map();
      for (const x of em.samples) {
        if (!per.has(x.page)) {
          per.set(x.page, { planned: 0, valid: 0, failed: 0, notAttempted: 0, evidenceIncomplete: 0, samples: [] });
          order.push(x.page);
        }
        const c = per.get(x.page);
        c.planned += 1;
        if (x.status === 'ok') c.valid += 1;
        else if (x.status === 'failed') c.failed += 1;
        else if (x.status === 'not-attempted') c.notAttempted += 1;
        else c.evidenceIncomplete += 1;
        const rt = x.attempts?.find((a) => !a.internalRetry)?.lhr?.runtimeError?.code ?? null;
        c.samples.push({ planned: x.planned, runIndex: x.runIndex, status: x.status, slotOutcome: x.slotOutcome ?? null, rawLhr: x.rawLhr ?? null,
          runtimeError: rt, values: x.rawLhr && runByFile.has(x.rawLhr) ? runByFile.get(x.rawLhr) : null });
      }
      const known = new Map(pages.map((pg) => [pg.url, pg]));
      const merged = [];
      for (const url of order) {
        const c = per.get(url);
        const pg = known.get(url) ?? { url, runs: 0, runtimeErrors: 0, median: null, max: null };
        known.delete(url);
        const complete = c.valid === c.planned && c.planned > 0;
        merged.push({
          ...pg,
          samples: { planned: c.planned, valid: c.valid, failed: c.failed, notAttempted: c.notAttempted, evidenceIncomplete: c.evidenceIncomplete },
          aggregation: complete ? 'ok' : 'incomplete',
          ...(complete ? {} : { median: null, max: null, observations: c.samples }),
        });
      }
      // 对应表里没有的页面（raw 里有、计划里没有）照样列出，标为不完整
      for (const pg of known.values())
        merged.push({ ...pg, samples: null, aggregation: 'incomplete', median: null, max: null, observations: runs.filter((r) => r.url === pg.url) });
      pages.splice(0, pages.length, ...merged);
    }
  }
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
    ...(slotView ? { slots: slotView } : {}),
    pages,
    runs,
  };
}

function toMd(s) {
  const f = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));
  if (s.slots) return toMdSlots(s, f);
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

// r25：证据模式（有 evidence-map.json）的摘要：每页计划 / 有效 / 失败 / 未尝试 / 证据不完整；不完整页不给中位数，逐次值另列为观测数据
function toMdSlots(s, f) {
  const INC = '不完整，不满足原定聚合条件';
  const tot = { planned: 0, valid: 0, failed: 0, notAttempted: 0, evidenceIncomplete: 0 };
  for (const p of s.pages) if (p.samples) for (const k of Object.keys(tot)) tot[k] += p.samples[k];
  const cnt = (p) => (p.samples ? `${p.samples.planned} / ${p.samples.valid} / ${p.samples.failed} / ${p.samples.notAttempted} / ${p.samples.evidenceIncomplete}` : '— / — / — / — / —');
  const inc = s.pages.filter((p) => p.aggregation !== 'ok');
  return [
    `### Lighthouse ${s.dir}（原始数据摘要；本档结论见 exit-codes.json）`,
    '',
    `${Object.entries(s.steps ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ')} · 证据对应表 ${s.slots.evidenceMap}（${s.slots.status ?? '—'}）· 样本 计划 ${tot.planned} / 有效 ${tot.valid} / 失败 ${tot.failed} / 未尝试 ${tot.notAttempted} / 证据不完整 ${tot.evidenceIncomplete} · LHR ${s.lhrCount} 个（可解析 ${s.parsedLhrCount}）· assertion-results=${s.assertionResults} · 未通过/警告条目 ${s.failedOrWarnAssertionEntries ?? '—'}`,
    '',
    '| 页面 | 计划 / 有效 / 失败 / 未尝试 / 证据不完整 | LCP 中位 ms | CLS 中位 | CLS 最大 | TBT 中位 ms | TBT 最大 ms | 脚本 B | 性能 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...s.pages.map((p) =>
      p.aggregation === 'ok'
        ? `| ${p.url.replace(/^https?:\/\/[^/]+/, '')} | ${cnt(p)} | ${f(p.median.lcp)} | ${f(p.median.cls, 4)} | ${f(p.max.cls, 4)} | ${f(p.median.tbt)} | ${f(p.max.tbt)} | ${f(p.median.script)} | ${f(p.median.performance, 2)} |`
        : `| ${p.url.replace(/^https?:\/\/[^/]+/, '')} | ${cnt(p)} | ${INC} | ${INC} | ${INC} | ${INC} | ${INC} | ${INC} | ${INC} |`,
    ),
    '',
    ...(inc.length
      ? [
          '#### 不完整页面的逐次原始值（观测数据，不作验收、不聚合）',
          '',
          '| 页面 | 计划样本 # | 第几次 | 证据状态 | runtimeError | LCP ms | CLS | TBT ms | 脚本 B | 性能 |',
          '|---|---|---|---|---|---|---|---|---|---|',
          ...inc.flatMap((p) =>
            (p.observations ?? []).map((o) => {
              const v = o.values ?? (o.url ? o : null);
              return `| ${p.url.replace(/^https?:\/\/[^/]+/, '')} | ${o.planned ?? '—'} | ${o.runIndex ?? '—'} | ${o.status ?? '对应表外'} | ${o.runtimeError ?? '—'} | ${f(v?.lcp)} | ${f(v?.cls, 4)} | ${f(v?.tbt)} | ${f(v?.script)} | ${f(v?.performance, 2)} |`;
            }),
          ),
          '',
        ]
      : []),
    ...s.failedAssertions.map(
      (x) =>
        `- ✗ ${x.url} ${x.auditId}${x.name ? `.${x.name}` : ''}：实际 ${x.actual} ${x.operator ?? ''} 期望 ${x.expected}`,
    ),
    '',
  ].join('\n');
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
