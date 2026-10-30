#!/usr/bin/env node
/**
 * Lighthouse 一档的证据完整性核对（只读，不改任何文件）。lhci-tier.sh（归档后、写清单前）与 lhci-gate.sh（总结论）都调用它。
 *
 *   node scripts/ci/lhci-verify.mjs <档目录> <lighthouserc 配置> <页数>x<每页次数> [--json 输出文件]
 *
 * 核对的不只是哈希：
 *   - 配置本身：collect.url 去重后的页数 = 期望页数，collect.numberOfRuns = 期望每页次数（配置被改小 → 失败，不跟着配置走）；
 *   - raw/assertion-results.json：必须存在且能解析成数组。合法的空数组 [] = 没有未通过的断言；文件缺失 / 解析失败 / 不是数组 → 失败
 *     （两者分开记录：present-empty / present / missing / unparseable / not-array）。其中 level=error（或没写 level）的未通过条目 → 失败；
 *   - raw/lhr-*.json：每个都能解析；requestedUrl 必须在配置的页面清单里；每页正好 <每页次数> 个，总数 = 页数 × 次数；
 *     任何 runtimeError、任何缺失 / 非有限数的必需指标（LCP、CLS、TBT、四项分数、脚本 / 整页传输体积）→ 失败，绝不过滤掉后按剩下的算；
 *   - reports/manifest.json（lhci upload 的报告清单）：存在、能解析、条目数 = 页数 × 次数；
 *   - summary.json：存在、能解析、lhrCount 与原始 LHR 数一致。
 * 预算与聚合方式不在这里判断（那是 lhci assert 的事，配置不变），这里只保证「判断所依据的证据是完整的」。
 * 退出码：0 = 完整；1 = 不完整（问题逐条列出）；2 = 用法错误。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_AUDITS = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time'];
export const REQUIRED_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
export const REQUIRED_RESOURCES = ['script', 'total'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const readJson = (p) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

export function loadConfig(cfgPath) {
  const req = createRequire(pathToFileURL(resolve(cfgPath)).href);
  const abs = resolve(cfgPath);
  delete req.cache[abs];
  const c = req(abs)?.ci?.collect ?? {};
  return { urls: Array.isArray(c.url) ? c.url : [], numberOfRuns: c.numberOfRuns };
}

/** 一个 LHR 缺了哪些必需项（空数组 = 齐全） */
export function lhrProblems(lhr) {
  const p = [];
  if (!lhr || typeof lhr !== 'object') return ['不是对象'];
  if (lhr.runtimeError) p.push(`runtimeError ${lhr.runtimeError.code ?? JSON.stringify(lhr.runtimeError)}`);
  if (typeof lhr.requestedUrl !== 'string') p.push('缺 requestedUrl');
  for (const a of REQUIRED_AUDITS) if (!isNum(lhr.audits?.[a]?.numericValue)) p.push(`缺指标 ${a}`);
  for (const c of REQUIRED_CATEGORIES) if (!isNum(lhr.categories?.[c]?.score)) p.push(`缺分数 ${c}`);
  const items = lhr.audits?.['resource-summary']?.details?.items;
  for (const t of REQUIRED_RESOURCES) {
    const it = Array.isArray(items) ? items.find((i) => i?.resourceType === t) : undefined;
    if (!isNum(it?.transferSize)) p.push(`缺体积 resource-summary:${t}`);
  }
  return p;
}

export function verifyTier(dir, cfgPath, expectPages, expectRuns) {
  const problems = [];
  const report = { dir, config: cfgPath, expected: { pages: expectPages, runsPerPage: expectRuns } };

  // 1. 配置与期望一致
  let cfg = { urls: [], numberOfRuns: undefined };
  try {
    cfg = loadConfig(cfgPath);
  } catch (e) {
    problems.push(`配置 ${cfgPath} 读不出：${e?.message ?? e}`);
  }
  const cfgUrls = [...new Set(cfg.urls)];
  report.configPages = cfgUrls.length;
  report.configRunsPerPage = cfg.numberOfRuns ?? null;
  if (cfgUrls.length !== cfg.urls.length)
    problems.push(`配置里有重复页面（${cfg.urls.length} 条 / 去重 ${cfgUrls.length}）`);
  if (cfgUrls.length !== expectPages) problems.push(`配置页数 ${cfgUrls.length} ≠ 期望 ${expectPages}`);
  if (cfg.numberOfRuns !== expectRuns) problems.push(`配置每页次数 ${cfg.numberOfRuns} ≠ 期望 ${expectRuns}`);

  // 2. assertion-results.json：缺失与合法空数组分开
  const arPath = join(dir, 'raw', 'assertion-results.json');
  let ar = null;
  if (!existsSync(arPath) || !statSync(arPath).isFile()) {
    report.assertionResults = 'missing';
    problems.push('raw/assertion-results.json 缺失（不能当作「没有未通过的断言」）');
  } else {
    const r = readJson(arPath);
    if (!r.ok) {
      report.assertionResults = 'unparseable';
      problems.push(`raw/assertion-results.json 解析失败：${r.error}`);
    } else if (!Array.isArray(r.value)) {
      report.assertionResults = 'not-array';
      problems.push('raw/assertion-results.json 不是数组');
    } else {
      ar = r.value;
      report.assertionResults = ar.length === 0 ? 'present-empty' : 'present';
    }
  }
  // LHCI 只把「未通过」的断言写进这个文件（含 warn 级），所以这是条目数，不是执行过的断言总数
  report.failedOrWarnAssertionEntries = ar ? ar.length : null;
  const errorEntries = (ar ?? []).filter((x) => x && x.passed === false && (x.level ?? 'error') === 'error');
  report.failedErrorLevelEntries = ar ? errorEntries.length : null;
  if (errorEntries.length)
    problems.push(`assertion-results.json 有 ${errorEntries.length} 条 error 级未通过断言`);

  // 3. 原始 LHR：页面集合、每页次数、runtimeError、必需指标
  const raw = join(dir, 'raw');
  const files = existsSync(raw)
    ? readdirSync(raw)
        .filter((f) => /^lhr-.*\.json$/.test(f))
        .sort()
    : [];
  if (!existsSync(raw)) problems.push('raw/ 目录缺失');
  const perUrl = new Map(cfgUrls.map((u) => [u, 0]));
  const bad = [];
  for (const f of files) {
    const r = readJson(join(raw, f));
    if (!r.ok) {
      bad.push(`${f}：解析失败`);
      continue;
    }
    const lhr = r.value;
    const p = lhrProblems(lhr);
    if (p.length) bad.push(`${f}（${lhr?.requestedUrl ?? '?'}）：${p.join('；')}`);
    const u = lhr?.requestedUrl;
    if (typeof u === 'string') {
      if (perUrl.has(u)) perUrl.set(u, perUrl.get(u) + 1);
      else bad.push(`${f}：页面 ${u} 不在配置清单里`);
    }
  }
  report.lhrFiles = files.length;
  report.invalidLhr = bad;
  if (bad.length)
    problems.push(`${bad.length} 个 LHR 不合格：${bad.slice(0, 5).join(' | ')}${bad.length > 5 ? ' …' : ''}`);
  const wrongCount = [...perUrl].filter(([, n]) => n !== expectRuns);
  report.pagesWithWrongSampleCount = wrongCount.map(([url, n]) => ({ url, samples: n }));
  if (wrongCount.length)
    problems.push(
      `${wrongCount.length} 页样本数 ≠ ${expectRuns}：${wrongCount
        .slice(0, 5)
        .map(([u, n]) => `${u}=${n}`)
        .join('，')}`,
    );
  if (files.length !== expectPages * expectRuns)
    problems.push(
      `原始 LHR ${files.length} 个 ≠ 期望 ${expectPages}×${expectRuns}=${expectPages * expectRuns}`,
    );

  // 4. 上传报告清单
  const mPath = join(dir, 'reports', 'manifest.json');
  if (!existsSync(mPath)) problems.push('reports/manifest.json 缺失');
  else {
    const r = readJson(mPath);
    if (!r.ok || !Array.isArray(r.value)) problems.push('reports/manifest.json 解析失败或不是数组');
    else {
      report.reportEntries = r.value.length;
      if (r.value.length !== expectPages * expectRuns)
        problems.push(`reports/manifest.json 条目 ${r.value.length} ≠ ${expectPages * expectRuns}`);
    }
  }

  // 5. 摘要
  const sPath = join(dir, 'summary.json');
  if (!existsSync(sPath)) problems.push('summary.json 缺失');
  else {
    const r = readJson(sPath);
    if (!r.ok) problems.push('summary.json 解析失败');
    else if (r.value.lhrCount !== files.length)
      problems.push(`summary.json lhrCount ${r.value.lhrCount} ≠ 原始 LHR ${files.length}`);
  }

  report.ok = problems.length === 0;
  report.problems = problems;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, cfg, spec, flag, out] = process.argv.slice(2);
  const m = /^(\d+)x(\d+)$/.exec(spec ?? '');
  if (!dir || !cfg || !m) {
    console.error('用法：lhci-verify.mjs <档目录> <配置> <页数>x<每页次数> [--json 输出文件]');
    process.exit(2);
  }
  const r = verifyTier(dir, cfg, Number(m[1]), Number(m[2]));
  if (flag === '--json' && out) writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  for (const p of r.problems) console.log(`::error title=Lighthouse 证据（${dir}）::${p}`);
  console.log(
    `证据核对 ${dir}：${r.ok ? '完整' : '不完整'}（LHR ${r.lhrFiles}，期望 ${m[1]}×${m[2]}，assertion-results=${r.assertionResults}，未通过/警告条目 ${r.failedOrWarnAssertionEntries}）`,
  );
  process.exit(r.ok ? 0 : 1);
}
