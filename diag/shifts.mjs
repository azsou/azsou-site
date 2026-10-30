#!/usr/bin/env node
// 固定目标桌面 CLS 诊断（r16，/search/ 与 /apps/ 共用）：逐样本解析 LHR + trace + devtools 日志，写 results.json 与 verdict.md。
// 固定目标只来自环境变量 DIAG_TARGET_URL（见 target.mjs）；缺失或不合法 → 退出 2，不猜目标。
//
// 口径（门槛 0.02 不变，分母固定 3，不重跑、不丢弃预热、不重试）：
//   - 数值有效：已尝试、退出码 0、LHR 可解析、requestedUrl 与最终 URL（finalDisplayedUrl / mainDocumentUrl / finalUrl）
//     都按 WHATWG URL「origin + 规范化 pathname」等于固定目标、无 runtimeError、CLS 为有限数且 ≥ 0。
//     别的页面的 LHR（例如 /apps/ 的 LHR 放进 /search/ 诊断）永远不算有效样本。
//   - 资产：只认 Lighthouse 12.6.1 --save-assets 为主导航写的 sample-N-0.trace.json / sample-N-0.devtoolslog.json
//     （asset-saver.js saveAssets：`${pathWithBasename}-${index}`，index 0 = 主导航，1 = pageLoadError 阶段）；其他编号只列出、不用。
//   - 时间原点：只用「目标主框架」上、documentLoaderURL 等于固定目标的那一个 navigationStart（帧 id + 导航 URL）；
//     多个候选时只用 devtools 日志里同一主框架、同一 loaderId(navigationId)、URL 等于目标的 Document 请求消歧；
//     缺失或消歧不了 → 保留原始时间戳、标「无法换算」、定位证据不完整。没有「任意非 about: URL」之类的回退。
//   - CLS 与 trace 一致性：有效 LHR 的 CLS > 0 但 trace 里 0 个 LayoutShift 事件 → CLS 结论照旧，定位证据记缺口
//     （不能写成「不需要截图」）；CLS = 0 且没有事件 → 正常、截图不需要。不要求事件分数之和等于 CLS。
//   - 定位证据完整：trace 与 devtools 日志都可解析、时间原点可换算，且每个位移事件的前 / 后截图帧都找到。
//     定位证据不完整不影响 CLS 数值事实，但不能声称「位移来源诊断已完成」。
//   - 结论：任一有效样本 > 0.02 →「复现 k/3」；3 个都有效且 ≤ 0.02 →「未复现」（不是「已修复」）；
//     1–2 个有效且都 ≤ 0.02 →「证据不足 / 部分有效」；0 个有效 →「无效」。
//   - 单个样本解析出错只记在该样本上，继续处理其他样本；不会让整批静默消失。
// 退出码：0 = 3 个样本都已处理、results.json 与 verdict.md 都写出（与 CLS 是否达标无关）；
//         2 = 结果文件写不出（此时 stderr 有原因）。证据是否完整由 status.mjs 单独判定。
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { targetFromEnv, checkLhrTarget, sameTarget, normalizeUrl } from './target.mjs';

const dir = process.argv[2] ?? 'out';
const PLANNED = 3;
const LIMIT = 0.02;
let TARGET;
try {
  TARGET = targetFromEnv();
} catch (e) {
  console.error(`::error::${e.message}：不解析、不写结论（不猜目标）`);
  process.exit(2);
}
const NEAR_MS = 100; // 位移前这么多毫秒内完成的请求，列为「时间上相邻」（只是候选，不是原因）

const errMsg = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
function readJson(path) {
  if (!existsSync(path)) return { status: 'missing' };
  try {
    return { status: 'ok', data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { status: 'corrupt', error: errMsg(e) };
  }
}

// ---- 采集记录 ----
const coll = readJson(join(dir, 'collection.json'));
const collectionIssues = [];
let collRows = [];
if (coll.status !== 'ok') collectionIssues.push(`collection.json ${coll.status}${coll.error ? `: ${coll.error}` : ''}`);
else if (!Array.isArray(coll.data?.samples)) collectionIssues.push('collection.json 没有 samples 数组');
else {
  collRows = coll.data.samples;
  if (coll.data.planned !== PLANNED) collectionIssues.push(`collection.json planned=${coll.data.planned}，应为 ${PLANNED}`);
  if (!sameTarget(coll.data.url, TARGET.raw)) collectionIssues.push(`collection.json url 不是固定目标（${String(coll.data.url).slice(0, 200)}）`);
}
let files = [];
try {
  files = readdirSync(dir);
} catch (e) {
  collectionIssues.push(`读不了目录 ${dir}: ${errMsg(e)}`);
}

// 只认 index 0（主导航）；其他编号（例如 -1 = pageLoadError 阶段）只列出，不拿来定位。
function pickAsset(i, suffix) {
  const re = new RegExp(`^sample-${i}(-(\\d+))?\\.${suffix.replace('.', '\\.')}$`);
  const hits = files.filter((f) => re.test(f)).sort();
  const want = `sample-${i}-0.${suffix}`;
  return { file: hits.includes(want) ? want : null, others: hits.filter((f) => f !== want) };
}

function analyzeSample(i) {
  const row = collRows.find((r) => Number(r?.sample) === i) ?? null;
  const s = {
    sample: i,
    planned: true,
    attempted: row ? row.attempted === true : null,
    exitCode: row && Number.isInteger(row.exitCode) ? row.exitCode : null,
    startMs: row?.startMs ?? null,
    endMs: row?.endMs ?? null,
    status: 'invalid',
    valid: false,
    invalidReasons: [],
    parseErrors: [],
    cls: null,
    clsRaw: null,
    lhr: { file: `sample-${i}.report.json`, status: 'missing' },
    evidence: {},
    evidenceComplete: false,
    localization: null,
  };
  const reasons = s.invalidReasons;
  if (!row) reasons.push('没有采集记录');
  else if (!s.attempted) reasons.push('未尝试');
  else if (s.exitCode === null) reasons.push('退出码缺失');
  else if (s.exitCode !== 0) reasons.push(`退出码 ${s.exitCode}${[124, 137].includes(s.exitCode) ? '（超时）' : ''}`);

  // ---- LHR：数值事实 ----
  const lhr = readJson(join(dir, s.lhr.file));
  s.lhr.status = lhr.status;
  if (lhr.status === 'corrupt') {
    s.lhr.error = lhr.error;
    s.parseErrors.push(`LHR 解析失败: ${lhr.error}`);
  }
  if (lhr.status === 'ok') {
    try {
      const L = lhr.data;
      s.lighthouseVersion = L.lighthouseVersion ?? null;
      s.userAgent = L.environment?.hostUserAgent ?? null;
      s.benchmarkIndex = L.environment?.benchmarkIndex ?? null;
      s.finalUrl = L.finalDisplayedUrl ?? L.finalUrl ?? null;
      const tb = checkLhrTarget(L, TARGET);
      s.targetBinding = { ok: tb.ok, urls: tb.urls, reasons: tb.reasons };
      for (const r of tb.reasons) reasons.push(`目标不符：${r}`);
      s.runtimeError = L.runtimeError?.code ?? null;
      const a = L.audits?.['cumulative-layout-shift'];
      s.clsRaw = a ? (a.numericValue ?? null) : null;
      s.lhLayoutShifts = L.audits?.['layout-shifts']?.details?.items ?? null; // 元素 + rootCauses（LH 12）；元素是「受影响元素」，不是根因
      s.observed = (L.audits?.metrics?.details?.items ?? [])[0] ?? null;
      if (s.runtimeError) reasons.push(`runtimeError ${s.runtimeError}`);
      if (s.clsRaw === null) reasons.push('CLS 缺失');
      else if (typeof s.clsRaw !== 'number' || !Number.isFinite(s.clsRaw)) reasons.push(`CLS 不是有限数（${JSON.stringify(s.clsRaw)}）`);
      else if (s.clsRaw < 0) reasons.push(`CLS 为负（${s.clsRaw}）`);
      else s.cls = s.clsRaw;
    } catch (e) {
      s.parseErrors.push(`LHR 字段读取失败: ${errMsg(e)}`);
      reasons.push('LHR 字段读取失败');
    }
  } else if (s.attempted) reasons.push(lhr.status === 'missing' ? 'LHR 缺失' : 'LHR 损坏');

  if (s.attempted === false || !row) s.status = 'missing';
  s.valid = reasons.length === 0;
  if (s.valid) s.status = 'valid';

  // ---- 定位证据（与数值有效性分开）----
  const ev = s.evidence;
  const tr = pickAsset(i, 'trace.json');
  const dl = pickAsset(i, 'devtoolslog.json');
  ev.lhr = s.lhr.status;
  ev.trace = { file: tr.file, status: 'missing' };
  ev.devtoolsLog = { file: dl.file, status: 'missing' };
  ev.timeOrigin = { status: 'n/a' };
  ev.screenshots = { status: 'n/a' };
  if (tr.others.length || dl.others.length)
    ev.nonPrimaryAssets = { files: [...tr.others, ...dl.others], note: '不是 index 0 主导航资产（-1 = Lighthouse pageLoadError 阶段），不用于定位' };

  let events = null;
  if (tr.file) {
    const t = readJson(join(dir, tr.file));
    ev.trace.status = t.status;
    if (t.status === 'corrupt') {
      ev.trace.error = t.error;
      s.parseErrors.push(`trace 解析失败: ${t.error}`);
    } else {
      events = Array.isArray(t.data) ? t.data : t.data?.traceEvents;
      if (!Array.isArray(events)) {
        ev.trace.status = 'corrupt';
        ev.trace.error = '没有 traceEvents 数组';
        s.parseErrors.push('trace 没有 traceEvents 数组');
        events = null;
      }
    }
  }

  let net = null;
  let docs = null; // devtools 日志里的 Document 请求（帧 id + loaderId + URL），只用于消歧 / 佐证目标导航
  if (dl.file) {
    const d = readJson(join(dir, dl.file));
    ev.devtoolsLog.status = d.status;
    if (d.status === 'corrupt') {
      ev.devtoolsLog.error = d.error;
      s.parseErrors.push(`devtools 日志解析失败: ${d.error}`);
    } else if (!Array.isArray(d.data)) {
      ev.devtoolsLog.status = 'corrupt';
      ev.devtoolsLog.error = '不是消息数组';
      s.parseErrors.push('devtools 日志不是消息数组');
    } else {
      const urls = new Map();
      net = [];
      for (const m of d.data) {
        const p = m?.params;
        if (m?.method === 'Network.requestWillBeSent' && p?.requestId) urls.set(p.requestId, p.request?.url);
        if (m?.method === 'Network.loadingFinished' && p?.requestId && typeof p.timestamp === 'number')
          net.push({ requestId: p.requestId, url: urls.get(p.requestId) ?? null, finishedTsUs: Math.round(p.timestamp * 1e6) });
      }
      docs = [];
      for (const m of d.data) {
        const p = m?.params;
        if (m?.method === 'Network.requestWillBeSent' && p?.type === 'Document')
          docs.push({ frameId: p.frameId ?? null, loaderId: p.loaderId ?? null, url: p.request?.url ?? null });
      }
      ev.devtoolsLog.messages = d.data.length;
      ev.devtoolsLog.finishedRequests = net.length;
    }
  }

  if (events) {
    try {
      // 目标主框架：TracingStartedInBrowser 里的 outermost main frame；没有它就无法证明 navigationStart 属于目标主框架
      const tsib = events.find((e) => e?.name === 'TracingStartedInBrowser');
      const mainFrames = (tsib?.args?.data?.frames ?? []).filter((f) => f?.frame && (f.isOutermostMainFrame ?? !f.parent));
      const mainFrame = mainFrames.length === 1 ? mainFrames[0].frame : null;
      // 时间原点：只用目标主框架上、文档 URL = 固定目标的 navigationStart；找不到 / 消歧不了 → 不换算（绝不用 0，绝不回退）
      const mainNavs = events.filter(
        (e) => e?.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame === true && typeof e.ts === 'number',
      );
      const inFrame = mainFrame ? mainNavs.filter((e) => e.args?.frame === mainFrame) : [];
      const cands = inFrame.filter((e) => sameTarget(e.args?.data?.documentLoaderURL, TARGET.raw));
      const docMatch = (e) =>
        docs === null
          ? null
          : docs.some((x) => x.frameId === mainFrame && x.loaderId !== null && x.loaderId === (e.args?.data?.navigationId ?? null) && sameTarget(x.url, TARGET.raw));
      let nav = null;
      let method = null;
      let why = null;
      if (!mainFrame) why = mainFrames.length > 1 ? `主框架不唯一（${mainFrames.length} 个）` : '没有主框架 id（TracingStartedInBrowser 缺失或无 outermost main frame）';
      else if (cands.length === 1) {
        nav = cands[0];
        method = '帧 id + 导航 URL 唯一匹配';
      } else if (cands.length > 1) {
        const byDoc = cands.filter((e) => docMatch(e) === true);
        if (byDoc.length === 1) {
          nav = byDoc[0];
          method = 'devtools 日志 Document 请求（同主框架 + loaderId=navigationId + 目标 URL）消歧';
        } else why = `目标主框架上有 ${cands.length} 个目标 navigationStart，devtools 日志消歧后 ${byDoc.length} 个（不唯一 / 无法消歧）`;
      } else {
        const other = inFrame.map((e) => String(e.args?.data?.documentLoaderURL ?? '')).filter((u) => u !== '' && !u.startsWith('about:'));
        why = other.length
          ? `目标主框架上只有其他页面的 navigationStart（${[...new Set(other)].map((u) => (normalizeUrl(u).ok ? normalizeUrl(u).path : '无法解析')).join(', ')}）`
          : inFrame.length
            ? '目标主框架上只有 about:blank / 空 URL 的 navigationStart（没找到目标导航）'
            : '目标主框架上没有 navigationStart（没找到目标导航）';
      }
      ev.timeOrigin = nav
        ? {
            status: 'ok',
            ts: nav.ts,
            documentLoaderURL: nav.args.data.documentLoaderURL,
            frame: nav.args.frame,
            navigationId: nav.args?.data?.navigationId ?? null,
            method,
            devtoolsCorroborated: docMatch(nav),
          }
        : { status: '无法换算', reason: why, mainFrame, targetCandidates: cands.length };
      const t0 = nav ? nav.ts : null;
      const rel = (ts) => (t0 === null || typeof ts !== 'number' ? null : (ts - t0) / 1000);

      const shots = events
        .filter((e) => e?.name === 'Screenshot' && typeof e.ts === 'number' && e.args?.snapshot)
        .sort((a, b) => a.ts - b.ts); // 按时间排序，不依赖文件里的顺序
      s.traceScreenshotCount = shots.length;

      s.traceShifts = events
        .filter((e) => e?.name === 'LayoutShift')
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .map((e, k) => {
          const d = e.args?.data ?? {};
          const sh = {
            index: k,
            tsRaw: typeof e.ts === 'number' ? e.ts : null,
            ms: rel(e.ts),
            msNote: t0 === null ? '无法换算（没有可唯一确定的目标导航 navigationStart；保留原始时间戳 tsRaw）' : undefined,
            score: d.score ?? null,
            weighted: d.weighted_score_delta ?? null,
            hadRecentInput: d.had_recent_input ?? null,
            frame: e.args?.frame ?? null,
            inMainFrame: mainFrame ? e.args?.frame === mainFrame : null,
            impacted: d.impacted_nodes ?? null,
            frames: {},
          };
          if (sh.tsRaw === null) {
            sh.frames = { status: 'missing', reason: '位移事件没有时间戳' };
            return sh;
          }
          let before = null;
          let after = null;
          for (const x of shots) {
            if (x.ts <= sh.tsRaw) before = x;
            else {
              after = x;
              break;
            }
          }
          for (const [tag, x] of [
            ['before', before],
            ['after', after],
          ]) {
            if (!x) {
              sh.frames[tag] = { status: 'missing' };
              continue;
            }
            const label = t0 === null ? `raw${x.ts}` : `${Math.round((x.ts - t0) / 1000)}ms`;
            const f = `sample-${i}-shift${k}-${tag}-${label}.jpg`;
            try {
              writeFileSync(join(dir, f), Buffer.from(x.args.snapshot, 'base64'));
              sh.frames[tag] = { status: 'ok', file: f, tsRaw: x.ts, ms: rel(x.ts) };
            } catch (e2) {
              sh.frames[tag] = { status: 'write_failed', error: errMsg(e2) };
              s.parseErrors.push(`截图写入失败 ${f}: ${errMsg(e2)}`);
            }
          }
          if (net && t0 !== null)
            sh.requestsFinishedWithin100msBefore = net
              .filter((r) => r.finishedTsUs <= sh.tsRaw && sh.tsRaw - r.finishedTsUs <= NEAR_MS * 1000)
              .map((r) => ({ url: r.url, ms: rel(r.finishedTsUs) }));
          return sh;
        });
      const need = s.traceShifts.length;
      const missingFrames = s.traceShifts.flatMap((sh) =>
        ['before', 'after'].filter((t) => sh.frames[t]?.status !== 'ok').map((t) => `shift${sh.index}-${t}`),
      );
      // CLS 与 trace 一致性（只看「有没有事件」，不要求分数之和 = CLS）
      const scoreSum = s.traceShifts.reduce((a, x) => a + (typeof x.weighted === 'number' && !x.hadRecentInput ? x.weighted : 0), 0);
      ev.clsTraceConsistency = { lhrCls: s.cls, traceLayoutShiftEvents: need, traceWeightedScoreSum: scoreSum, sumMustEqualCls: false };
      ev.screenshots =
        need === 0
          ? s.valid && s.cls > 0
            ? { status: 'gap', reason: `有效 LHR 的 CLS = ${s.cls} > 0，但 trace 中 0 个 LayoutShift 事件：CLS 结论保留，位移来源无法定位` }
            : { status: 'not_required', reason: 'CLS = 0 且 trace 中没有 LayoutShift 事件' }
          : missingFrames.length
            ? { status: 'incomplete', missing: missingFrames }
            : { status: 'ok', frames: need * 2 };
    } catch (e) {
      s.parseErrors.push(`trace 事件处理失败: ${errMsg(e)}`);
      ev.trace.status = 'corrupt';
      ev.trace.error = errMsg(e);
    }
  }

  const gaps = [];
  if (ev.lhr !== 'ok') gaps.push(`LHR ${ev.lhr}`);
  if (ev.trace.status !== 'ok') gaps.push(`trace ${ev.trace.status}`);
  if (ev.devtoolsLog.status !== 'ok') gaps.push(`devtools 日志 ${ev.devtoolsLog.status}`);
  if (ev.trace.status === 'ok' && ev.timeOrigin.status !== 'ok') gaps.push(`时间原点${ev.timeOrigin.status}`);
  if (ev.trace.status === 'ok' && ev.screenshots.status === 'gap') gaps.push(`CLS > 0 但 trace 无 LayoutShift 事件`);
  else if (ev.trace.status === 'ok' && !['ok', 'not_required'].includes(ev.screenshots.status))
    gaps.push(`截图 ${ev.screenshots.status}（${(ev.screenshots.missing ?? []).join(', ')}）`);
  s.evidenceGaps = gaps;
  s.evidenceComplete = s.valid && gaps.length === 0;
  s.localization = !s.valid
    ? '样本无效，不做定位'
    : s.evidenceComplete
      ? '位移来源证据完整（trace 事件 + 前后截图 + 网络时序）'
      : `只有 CLS 数值事实；不能声称位移来源诊断已完成（${gaps.join('；')}）`;
  return s;
}

const samples = [];
for (let i = 1; i <= PLANNED; i++) {
  try {
    samples.push(analyzeSample(i));
  } catch (e) {
    // 兜底：该样本记无效 + 解析错误，继续下一个
    samples.push({ sample: i, planned: true, status: 'invalid', valid: false, invalidReasons: ['解析器异常'], parseErrors: [errMsg(e)], evidenceComplete: false });
  }
}

const valid = samples.filter((s) => s.valid);
const nInvalid = samples.filter((s) => s.status === 'invalid').length;
const nMissing = samples.filter((s) => s.status === 'missing').length;
const over = valid.filter((s) => s.cls > LIMIT);
const counts = `有效 ${valid.length} / 无效 ${nInvalid} / 缺失 ${nMissing}（计划 ${PLANNED}）`;
let code;
let verdict;
if (over.length) {
  code = 'reproduced';
  verdict = `复现 ${over.length}/${PLANNED}（CLS > ${LIMIT}）；${counts}`;
} else if (valid.length === PLANNED) {
  code = 'not_reproduced';
  verdict = `未复现（${PLANNED}/${PLANNED} 个有效样本 CLS ≤ ${LIMIT}；不等于已修复，原运行的失败值照旧记录）；${counts}`;
} else if (valid.length > 0) {
  code = 'insufficient';
  verdict = `证据不足 / 部分有效（${valid.length}/${PLANNED} 个有效样本且都 ≤ ${LIMIT}）；${counts}`;
} else {
  code = 'invalid';
  verdict = `无效（0/${PLANNED} 个有效样本）；${counts}`;
}
const evidenceComplete = samples.every((s) => s.evidenceComplete);
const result = {
  schema: 'diag-cls/results@r16',
  target: { url: TARGET.raw, origin: TARGET.origin, path: TARGET.path, compare: 'WHATWG URL origin + pathname（去末尾 /）' },
  planned: PLANNED,
  limit: LIMIT,
  verdict: { code, text: verdict, reproduced: over.length, valid: valid.length, invalid: nInvalid, missing: nMissing },
  evidence: {
    status: evidenceComplete ? 'complete' : valid.some((s) => s.evidenceComplete) ? 'partial' : 'none',
    perSample: samples.map((s) => ({ sample: s.sample, complete: !!s.evidenceComplete, gaps: s.evidenceGaps ?? s.invalidReasons })),
  },
  collectionIssues,
  notes: [
    '任务成功只代表采集 / 整理完成，不代表 CLS 达标。',
    'layout-shifts 审计里的元素是受影响元素（例如 footer），不是根因。',
  ],
  samples,
};

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));
const md = [];
md.push(`### ${TARGET.path} 桌面 CLS 诊断：${verdict}`, '');
md.push(`定位证据：${result.evidence.status}。任务成功只代表采集 / 整理完成，不代表 CLS 达标。`, '');
if (collectionIssues.length) md.push(`采集记录问题：${collectionIssues.join('；')}`, '');
md.push('| 样本 | 尝试 | 退出码 | CLS | 有效 | 无效原因 | LayoutShift 事件 | 定位证据 |');
md.push('|---|---|---|---|---|---|---|---|');
for (const s of samples)
  md.push(
    `| ${s.sample} | ${s.attempted === null ? '无记录' : s.attempted ? '是' : '否'} | ${fmt(s.exitCode)} | ${fmt(s.cls ?? s.clsRaw)} | ${s.valid ? '是' : '否'} | ${s.invalidReasons.join('；') || '—'} | ${fmt(s.traceShifts?.length)} | ${s.evidenceComplete ? '完整' : (s.evidenceGaps ?? []).join('；') || '—'} |`,
  );
const errs = samples.flatMap((s) => (s.parseErrors ?? []).map((e) => `- 样本 ${s.sample}：${e}`));
if (errs.length) md.push('', '解析错误（逐样本记录，其他样本照常处理）：', ...errs);

let wrote = true;
for (const [name, body] of [
  ['results.json', JSON.stringify(result, null, 2) + '\n'],
  ['verdict.md', md.join('\n') + '\n'],
]) {
  try {
    writeFileSync(join(dir, `${name}.tmp`), body);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  } catch (e) {
    wrote = false;
    console.error(`::error::写 ${name} 失败: ${errMsg(e)}`);
  }
}
if (wrote) console.log(md.join('\n'));
process.exit(wrote ? 0 : 2);
