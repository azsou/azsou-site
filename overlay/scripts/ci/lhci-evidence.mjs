#!/usr/bin/env node
/**
 * Lighthouse 一档的「计划样本 → 实际尝试 → LHR / trace / devtools 日志」对应表（r18；r19 加资产可用性与目标归属核对；r20 navigationId 必须存在且匹配）。只读（build 只写 evidence-map.json）。
 *
 *   node scripts/ci/lhci-evidence.mjs build <档目录> <lighthouserc 配置> <页数>x<每页次数>   → 写 <档目录>/evidence-map.json
 *   node scripts/ci/lhci-evidence.mjs check <档目录> <lighthouserc 配置> <页数>x<每页次数>   → 重新计算并与 evidence-map.json 比对（lhci-gate.sh 用）
 *
 * 输入：<档目录>/attempts/attempts.jsonl + attempt-NNN/（lhci-attempt-hook.cjs 写的）、<档目录>/raw/lhr-*.json（.lighthouseci 归档）。
 * 计划样本顺序 = LHCI collect 的顺序：collect.url 依次，每页连续 numberOfRuns 次（@lhci/cli 0.15.1 collect.js 第 130、253–256 行）。
 * 每个计划样本必须满足（否则逐条列出问题、退出码 1；绝不按剩下的算）：
 *   - 正好一次真实尝试（被钩子阻止的内部重试单独计数，出现即失败）；尝试的 URL = 计划 URL；
 *   - 退出码 0；stdout.json 能解析成 LHR，requestedUrl = 计划 URL，configSettings.formFactor = 本档配置的 formFactor
 *     （preset desktop → desktop，否则 settings.formFactor，默认 mobile）——防止跨档混淆；
 *   - attempt 目录里有 <前缀>-0.trace.json 与 <前缀>-0.devtoolslog.json，前缀 = Lighthouse 自己的
 *     getLhrFilenamePrefix(LHR)（主机名 + fetchTime，按本机时区，精确到秒），用固定版本 lighthouse 的 file-namer 计算；
 *   - stdout.json 的 sha256 与 raw/ 里正好一个 lhr-*.json 相同，且这个 lhr 没被别的样本占用（1:1，不重不漏）。
 *   （r19）资产可用、归属于计划页面——按内容核对，不按文件名前缀：
 *   - stdout.json 与 stderr.log 都必须存在且是普通文件（stderr.log 可以为空；stdout.json 不能为空）；
 *   - trace 能解析，且是 Lighthouse 12.6.1 保存的格式：{ traceEvents: [...] }（asset-saver.js saveTrace / traceJsonGenerator）
 *     或数组形式 [...]；事件非空、每个事件是带字符串 name / ph 的对象；
 *   - devtools 日志能解析，是非空数组，每条是带字符串 method、对象 params 的协议消息；
 *   - 目标归属（URL 一律按 WHATWG URL 规范化成 origin + 去末尾斜杠的 pathname + search 再比较）：
 *       LHR requestedUrl / finalDisplayedUrl（及存在时的 mainDocumentUrl / finalUrl）= 计划页面；
 *       trace 里主框架（isOutermostMainFrame）非 about: 的 navigationStart.documentLoaderURL 至少一个、全部 = 计划页面、只属于一个框架；
 *       devtools 日志里顶层框架（无 parentId）的 Page.frameNavigated 非 about: URL 至少一个、全部 = 计划页面，
 *       该框架的主文档导航请求（Network.requestWillBeSent，type=Document，requestId = loaderId）至少一个、URL 全部 = 计划页面；
 *       trace 主框架 id 必须是 devtools 顶层框架之一；（r20）归属用的每个主框架 navigationStart 都必须带有效 navigationId（非空字符串），
 *       且等于 devtools 日志里同一框架主文档请求的 loaderId；缺失 / 为空 / 对不上 = incomplete，不退回只按 URL / 框架判定。
 *   任何一项读不出 / 判不了 = 该样本 incomplete（不是 ok），原文件一个都不动。这里只核对证据归属，不分析 CLS 成因。
 * 失败样本（退出码非 0）、没尝试到的样本、raw 里对不上的 LHR、attempts 目录里认领不了的文件、仓库根目录的游离资产都会写进表里并判失败；
 * 已产生的文件一个都不删。
 * 退出码：0 = 完整；1 = 不完整 / 有失败样本；2 = 用法错误。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PIN = resolve(here, '../../tools/lhci/node_modules');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const fileInfo = (p) => ({ name: p.split('/').pop(), bytes: statSync(p).size, sha256: sha(p) });
const readJson = (p) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

// ---- r19：资产可用性与目标归属 ----
export function normUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  let x;
  try {
    x = new URL(u);
  } catch {
    return null;
  }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
  return `${x.origin}${x.pathname.replace(/\/+$/, '') || '/'}${x.search}`;
}
const isAbout = (u) => typeof u !== 'string' || u === '' || u.startsWith('about:');
function readJsonFile(p, label, sp) {
  let st;
  try {
    st = statSync(p);
  } catch {
    sp.push(`缺 ${label}`);
    return { ok: false };
  }
  if (!st.isFile()) {
    sp.push(`${label} 不是普通文件`);
    return { ok: false };
  }
  if (st.size === 0) {
    sp.push(`${label} 是 0 字节`);
    return { ok: false };
  }
  const j = readJson(p);
  if (!j.ok) sp.push(`${label} 解析失败：${j.error}`);
  return j;
}

/** trace：格式 + 主框架导航归属。返回 info（写进对应表），问题写进 sp。 */
export function checkTrace(p, planned, sp) {
  const info = { format: null, events: null, mainFrameId: null, navigationUrls: [], navigationIds: [] };
  const j = readJsonFile(p, 'trace', sp);
  if (!j.ok) return info;
  const v = j.value;
  const events = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray(v.traceEvents) ? v.traceEvents : null;
  if (!events) {
    sp.push('trace 不是 Lighthouse 12.6.1 的格式（应为 { traceEvents: [...] } 或数组）');
    return info;
  }
  info.format = Array.isArray(v) ? 'array' : 'object';
  info.events = events.length;
  if (events.length === 0) {
    sp.push('trace 没有任何事件');
    return info;
  }
  const badEv = events.filter((e) => !e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.ph !== 'string').length;
  if (badEv) sp.push(`trace 有 ${badEv} 个事件不是带 name / ph 的对象`);
  const navs = events.filter((e) => {
    if (!e || e.name !== 'navigationStart') return false;
    const d = e.args?.data;
    if (!d) return false;
    const main = d.isOutermostMainFrame === true || (d.isOutermostMainFrame === undefined && d.isLoadingMainFrame === true);
    return main && !isAbout(d.documentLoaderURL);
  });
  if (navs.length === 0) {
    sp.push('trace 里没有主框架导航（主框架、非 about: 的 navigationStart），无法确认归属');
    return info;
  }
  const frames = [...new Set(navs.map((e) => e.args?.frame ?? null))];
  info.navigationUrls = [...new Set(navs.map((e) => e.args.data.documentLoaderURL))];
  // r20：归属用的主框架导航必须带有效 navigationId（非空字符串）；缺失 / 空 / 非字符串 → 不完整，绝不退回只按 URL / 框架判定
  const badIds = navs.filter((e) => typeof e.args.data.navigationId !== 'string' || e.args.data.navigationId.trim() === '');
  info.navigationIds = [...new Set(navs.map((e) => e.args.data.navigationId).filter((id) => typeof id === 'string' && id.trim() !== ''))];
  info.navigationIdMissing = badIds.length;
  if (badIds.length)
    sp.push(
      `trace 主框架导航有 ${badIds.length} 个 navigationStart 缺有效 navigationId（${badIds.map((e) => JSON.stringify(e.args.data.navigationId ?? null)).join(', ')}），无法证明与 devtools 日志是同一次导航`,
    );
  const wrong = info.navigationUrls.filter((u) => normUrl(u) !== planned);
  if (wrong.length) sp.push(`trace 主框架导航到 ${wrong.join(', ')}，≠ 计划页面`);
  if (frames.length !== 1 || !frames[0]) sp.push(`trace 主框架导航属于 ${frames.length} 个框架（应正好 1 个），无法确认归属`);
  else info.mainFrameId = frames[0];
  return info;
}

/** devtools 日志：格式 + 顶层框架 / 主文档请求归属，并与 trace 主框架交叉核对。 */
export function checkDevtools(p, planned, traceInfo, sp) {
  const info = { messages: null, topFrameIds: [], frameNavigatedUrls: [], mainDocument: [] };
  const j = readJsonFile(p, 'devtools 日志', sp);
  if (!j.ok) return info;
  const v = j.value;
  if (!Array.isArray(v)) {
    sp.push('devtools 日志不是协议消息数组');
    return info;
  }
  info.messages = v.length;
  if (v.length === 0) {
    sp.push('devtools 日志是空数组');
    return info;
  }
  const bad = v.filter((m) => !m || typeof m !== 'object' || typeof m.method !== 'string' || !m.params || typeof m.params !== 'object').length;
  if (bad) sp.push(`devtools 日志有 ${bad} 条不是带 method / params 的协议消息`);
  const msgs = v.filter((m) => m && typeof m.method === 'string' && m.params && typeof m.params === 'object');
  const navs = msgs.filter((m) => m.method === 'Page.frameNavigated' && m.params.frame && !m.params.frame.parentId && !isAbout(m.params.frame.url));
  const top = [...new Set(navs.map((m) => m.params.frame.id).filter(Boolean))];
  info.topFrameIds = top;
  info.frameNavigatedUrls = [...new Set(navs.map((m) => m.params.frame.url))];
  if (navs.length === 0) sp.push('devtools 日志里没有顶层框架导航（Page.frameNavigated，无 parentId，非 about:），无法确认归属');
  const wrongNav = info.frameNavigatedUrls.filter((u) => normUrl(u) !== planned);
  if (wrongNav.length) sp.push(`devtools 日志顶层框架导航到 ${wrongNav.join(', ')}，≠ 计划页面`);
  const docs = msgs.filter(
    (m) =>
      m.method === 'Network.requestWillBeSent' &&
      m.params.type === 'Document' &&
      m.params.requestId &&
      m.params.requestId === m.params.loaderId &&
      top.includes(m.params.frameId),
  );
  info.mainDocument = docs.map((m) => ({ frameId: m.params.frameId, loaderId: m.params.loaderId, url: m.params.request?.url ?? null }));
  if (docs.length === 0) sp.push('devtools 日志里没有顶层框架的主文档导航请求，无法确认归属');
  const wrongDoc = [...new Set(info.mainDocument.map((d) => d.url))].filter((u) => normUrl(u) !== planned);
  if (wrongDoc.length) sp.push(`devtools 日志主文档请求 ${wrongDoc.join(', ')}，≠ 计划页面`);
  if (!traceInfo.mainFrameId) {
    // trace 那边已记录原因；这里再明确：没有可用的主框架就不做「同一次导航」判定，样本不可能是 ok
    sp.push('trace 没有可确认的主框架，无法与 devtools 日志核对是否同一次导航');
  } else {
    if (!top.includes(traceInfo.mainFrameId)) sp.push(`trace 主框架 ${traceInfo.mainFrameId} 不在 devtools 日志的顶层框架里（两份资产不是同一次导航）`);
    // r20：navigationId 必须存在且有效，并且等于同一框架主文档请求的 loaderId；没有 navigationId 不能当作「对得上」
    if (traceInfo.navigationIds.length === 0) sp.push('trace 主框架导航没有有效 navigationId，无法与 devtools 主文档请求的 loaderId 核对（不按 URL / 框架降级判定）');
    const loaders = new Set(info.mainDocument.filter((d) => d.frameId === traceInfo.mainFrameId).map((d) => d.loaderId));
    const miss = traceInfo.navigationIds.filter((id) => !loaders.has(id));
    if (miss.length) sp.push(`trace navigationId ${miss.join(', ')} 在 devtools 日志同一框架的主文档请求 loaderId 里找不到（两份资产不是同一次导航）`);
  }
  return info;
}

/** LHR 的目标归属（规范化 URL）。 */
export function checkLhrTarget(lhr, planned, sp) {
  for (const k of ['requestedUrl', 'finalDisplayedUrl', 'mainDocumentUrl', 'finalUrl']) {
    const optional = k === 'mainDocumentUrl' || k === 'finalUrl';
    if (lhr[k] === undefined && optional) continue;
    const n = normUrl(lhr[k]);
    if (!n) sp.push(`LHR ${k} 缺失或不是 http(s) URL（${lhr[k] ?? '无'}），无法确认归属`);
    else if (n !== planned) sp.push(`LHR ${k} ${lhr[k]} ≠ 计划页面`);
  }
}

export function loadCollect(cfgPath) {
  const abs = resolve(cfgPath);
  const req = createRequire(pathToFileURL(abs).href);
  delete req.cache[abs];
  return req(abs)?.ci?.collect ?? {};
}
export function expectedFormFactor(collect) {
  const s = collect.settings ?? {};
  if (s.formFactor) return s.formFactor;
  return s.preset === 'desktop' ? 'desktop' : 'mobile';
}

async function prefixFn() {
  const p = process.env.LH_FILE_NAMER || join(PIN, 'lighthouse/report/generator/file-namer.js');
  const m = await import(pathToFileURL(p).href);
  return m.getLhrFilenamePrefix;
}

export async function buildMap(dir, cfgPath, expect) {
  const problems = [];
  const m = /^(\d+)x(\d+)$/.exec(expect ?? '');
  if (!m) throw new Error(`期望格式应为 <页数>x<每页次数>：${expect}`);
  const [pages, runs] = [Number(m[1]), Number(m[2])];
  const collect = loadCollect(cfgPath);
  const urls = Array.isArray(collect.url) ? collect.url : [];
  if (urls.length !== pages) problems.push(`配置页数 ${urls.length} ≠ 期望 ${pages}`);
  if (collect.numberOfRuns !== runs) problems.push(`配置每页次数 ${collect.numberOfRuns} ≠ 期望 ${runs}`);
  const ff = expectedFormFactor(collect);
  const planned = [];
  urls.forEach((u, ui) => {
    for (let r = 1; r <= runs; r++) planned.push({ planned: planned.length + 1, page: u, pageIndex: ui + 1, runIndex: r, formFactor: ff });
  });

  let getPrefix = null;
  try {
    getPrefix = await prefixFn();
  } catch (e) {
    problems.push(`载入不了固定版本 lighthouse 的 file-namer（无法核对资产前缀）：${e?.message ?? e}`);
  }

  const adir = join(dir, 'attempts');
  const logPath = join(adir, 'attempts.jsonl');
  let recs = [];
  if (!existsSync(logPath)) problems.push('缺 attempts/attempts.jsonl（证据钩子没有生效或没有任何尝试）');
  else {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    lines.forEach((l, i) => {
      try {
        recs.push(JSON.parse(l));
      } catch {
        problems.push(`attempts.jsonl 第 ${i + 1} 行解析失败`);
      }
    });
  }
  const starts = recs.filter((r) => r.ev === 'start');
  const exits = new Map(recs.filter((r) => r.ev === 'exit').map((r) => [r.attempt, r]));
  starts.forEach((s, i) => {
    if (s.attempt !== i + 1) problems.push(`尝试序号不连续：第 ${i + 1} 条 start 是 #${s.attempt}`);
  });

  // raw LHR（归档）按 sha256 建索引
  const rawDir = join(dir, 'raw');
  const raw = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => /^lhr-\d+\.json$/.test(f)).sort() : [];
  const rawBySha = new Map();
  for (const f of raw) {
    const h = sha(join(rawDir, f));
    if (!rawBySha.has(h)) rawBySha.set(h, []);
    rawBySha.get(h).push(f);
  }
  const rawUsed = new Set();

  const claimed = new Set(['attempts.jsonl']);
  const samples = planned.map((p) => {
    const sp = [];
    const atts = starts.filter((s) => s.planned === p.planned);
    const real = atts.filter((s) => !s.retry);
    const blocked = atts.filter((s) => s.retry);
    const out = { ...p, attempts: [], blockedInternalRetries: blocked.length, rawLhr: null, status: 'ok', problems: sp };
    if (atts.length === 0) {
      out.status = 'not-attempted';
      sp.push('没有尝试（collect 在此之前已停止）');
      return out;
    }
    if (real.length !== 1) sp.push(`真实尝试 ${real.length} 次（应为 1）`);
    if (blocked.length) sp.push(`LHCI 内部重试 ${blocked.length} 次，已被钩子阻止（未测量）`);
    for (const s of atts) {
      const ex = exits.get(s.attempt);
      const a = {
        attempt: s.attempt,
        internalRetry: s.retry,
        url: s.url,
        exitCode: ex ? ex.code : null,
        exitReason: ex?.reason ?? null,
        start: s.t,
        end: ex?.t ?? null,
        chromePath: s.chromePath,
        githubRunId: s.githubRunId,
        githubRunAttempt: s.githubRunAttempt,
        files: [],
      };
      out.attempts.push(a);
      if (s.url !== p.page) sp.push(`尝试 #${s.attempt} 的 URL ${s.url} ≠ 计划 ${p.page}`);
      if (!ex) sp.push(`尝试 #${s.attempt} 没有退出记录（进程可能被杀）`);
      else if (ex.teeError) sp.push(`尝试 #${s.attempt} stdout/stderr 留存出错：${ex.teeError}`);
      if (s.retry) continue;
      const ad = join(adir, `attempt-${String(s.attempt).padStart(3, '0')}`);
      claimed.add(`attempt-${String(s.attempt).padStart(3, '0')}`);
      if (!existsSync(ad)) {
        sp.push(`缺尝试目录 ${ad}`);
        continue;
      }
      const names = readdirSync(ad).sort();
      a.files = names.map((f) => fileInfo(join(ad, f)));
      if (a.exitCode !== 0) {
        out.status = 'failed';
        sp.push(`尝试 #${s.attempt} 退出码 ${a.exitCode}（失败样本，已产生的文件原样保留）`);
      }
      const so = join(ad, 'stdout.json');
      const se = join(ad, 'stderr.log');
      // r19：stdout 与 stderr 都必须存在（stderr 可以为空）
      let seSt = null;
      try {
        seSt = statSync(se);
      } catch {
        /* 缺 */
      }
      if (!seSt) sp.push('缺 stderr.log');
      else if (!seSt.isFile()) sp.push('stderr.log 不是普通文件');
      const lj = readJsonFile(so, 'stdout.json', sp);
      if (!lj.ok) continue;
      const lhr = lj.value;
      if (!lhr || typeof lhr !== 'object' || Array.isArray(lhr)) {
        sp.push('stdout.json 不是 LHR 对象');
        continue;
      }
      a.lhr = {
        requestedUrl: lhr.requestedUrl,
        finalDisplayedUrl: lhr.finalDisplayedUrl,
        fetchTime: lhr.fetchTime,
        lighthouseVersion: lhr.lighthouseVersion,
        formFactor: lhr.configSettings?.formFactor,
        screenEmulation: lhr.configSettings?.screenEmulation ?? null,
        emulatedUserAgent: lhr.configSettings?.emulatedUserAgent ?? null,
        hostUserAgent: lhr.environment?.hostUserAgent ?? null,
        benchmarkIndex: lhr.environment?.benchmarkIndex ?? null,
        runtimeError: lhr.runtimeError ?? null,
        cls: lhr.audits?.['cumulative-layout-shift']?.numericValue ?? null,
      };
      if (lhr.requestedUrl !== p.page) sp.push(`LHR requestedUrl ${lhr.requestedUrl} ≠ 计划 ${p.page}`);
      const plannedNorm = normUrl(p.page);
      if (!plannedNorm) sp.push(`计划页面 ${p.page} 不是 http(s) URL，无法核对归属`);
      else checkLhrTarget(lhr, plannedNorm, sp);
      if (lhr.configSettings?.formFactor !== p.formFactor) sp.push(`LHR formFactor ${lhr.configSettings?.formFactor} ≠ 本档 ${p.formFactor}`);
      if (lhr.runtimeError) sp.push(`LHR runtimeError ${lhr.runtimeError.code ?? ''}`);
      if (getPrefix) {
        let prefix = null;
        try {
          prefix = getPrefix(lhr);
        } catch (e) {
          sp.push(`算不出资产前缀：${e?.message ?? e}`);
        }
        if (prefix) {
          a.assetPrefix = prefix;
          for (const k of ['trace', 'devtoolslog'])
            if (!names.includes(`${prefix}-0.${k}.json`)) sp.push(`缺 ${prefix}-0.${k}.json`);
          // r19：按内容核对可用性与归属（文件名前缀只用来在本尝试目录里找文件，不作归属证据）
          if (plannedNorm) {
            const tp = join(ad, `${prefix}-0.trace.json`);
            const dp = join(ad, `${prefix}-0.devtoolslog.json`);
            const ti = names.includes(`${prefix}-0.trace.json`) ? checkTrace(tp, plannedNorm, sp) : { mainFrameId: null, navigationIds: [] };
            const di = names.includes(`${prefix}-0.devtoolslog.json`) ? checkDevtools(dp, plannedNorm, ti, sp) : null;
            a.ownership = { plannedNormalized: plannedNorm, trace: ti, devtools: di };
          }
          const strays = names.filter((f) => f !== 'stdout.json' && f !== 'stderr.log' && !f.startsWith(`${prefix}-`));
          if (strays.length) sp.push(`尝试目录里有认领不了的文件：${strays.join(', ')}`);
        }
      }
      const h = sha(so);
      const hit = rawBySha.get(h) ?? [];
      if (a.exitCode === 0) {
        if (hit.length !== 1) sp.push(`stdout.json 在 raw/ 里匹配到 ${hit.length} 个 lhr（应为 1）`);
        else if (rawUsed.has(hit[0])) sp.push(`raw/${hit[0]} 已被别的样本占用`);
        else {
          rawUsed.add(hit[0]);
          out.rawLhr = hit[0];
        }
      } else if (hit.length) sp.push(`失败尝试的 LHR 出现在 raw/ 里：${hit.join(', ')}`);
    }
    if (sp.length && out.status === 'ok') out.status = 'incomplete';
    return out;
  });

  const extraStarts = starts.filter((s) => !(s.planned >= 1 && s.planned <= planned.length));
  if (extraStarts.length) problems.push(`有 ${extraStarts.length} 次尝试超出计划样本数 ${planned.length}`);
  const unclaimedRaw = raw.filter((f) => !rawUsed.has(f));
  if (unclaimedRaw.length) problems.push(`raw/ 里没有对应样本的 LHR：${unclaimedRaw.join(', ')}`);
  if (existsSync(adir)) {
    const extra = readdirSync(adir).filter((f) => !claimed.has(f));
    if (extra.length) problems.push(`attempts/ 里认领不了的条目：${extra.join(', ')}`);
  }
  const stray = join(dir, 'stray-assets');
  if (existsSync(stray)) problems.push(`仓库根目录出现过游离的 trace / devtools 文件（已移到 stray-assets/）：${readdirSync(stray).join(', ')}`);
  const envP = join(dir, 'env.json');
  const env = existsSync(envP) ? readJson(envP) : { ok: false, error: '缺 env.json' };
  if (!env.ok) problems.push(`环境记录不可用：${env.error}`);
  else {
    const paths = new Set(starts.filter((s) => !s.retry).map((s) => s.chromePath));
    if (paths.size > 1) problems.push(`各尝试的 CHROME_PATH 不一致：${[...paths].join(', ')}`);
    const used = [...paths][0];
    if (used && env.value.browser?.path && used !== env.value.browser.path)
      problems.push(`实际 CHROME_PATH ${used} ≠ 环境记录 ${env.value.browser.path}`);
  }

  const counts = {};
  for (const s of samples) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const status = problems.length === 0 && samples.every((s) => s.status === 'ok') ? 'complete' : 'incomplete';
  return {
    schema: 'az-lhci-evidence/2',
    config: cfgPath,
    expect,
    formFactor: ff,
    planned: planned.length,
    attemptsTotal: starts.length,
    blockedInternalRetries: starts.filter((s) => s.retry).length,
    github: {
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      sha: process.env.GITHUB_SHA || null,
    },
    counts,
    status,
    problems,
    samples,
  };
}

async function main() {
  const [mode, dir, cfg, expect] = process.argv.slice(2);
  if (!['build', 'check'].includes(mode) || !dir || !cfg || !expect) {
    console.error('用法：lhci-evidence.mjs build|check <档目录> <配置> <页数>x<每页次数>');
    process.exit(2);
  }
  let map;
  try {
    map = await buildMap(dir, cfg, expect);
  } catch (e) {
    console.error(`::error title=Lighthouse 证据对应表::${e?.message ?? e}`);
    process.exit(1);
  }
  // github 块在 check 时以文件为准（gate 也在同一次运行里，但不让环境差异制造假失败）；其余必须逐字节一致
  const target = join(dir, 'evidence-map.json');
  if (mode === 'build') {
    writeFileSync(target, `${JSON.stringify(map, null, 1)}\n`);
  } else {
    const f = readJson(target);
    if (!f.ok) {
      console.error(`::error title=Lighthouse 证据对应表::evidence-map.json 不可读：${f.error}`);
      process.exit(1);
    }
    map.github = f.value.github;
    if (JSON.stringify(f.value) !== JSON.stringify(map)) {
      console.error('::error title=Lighthouse 证据对应表::evidence-map.json 与重新计算的结果不一致（文件被改动或证据变化）');
      process.exit(1);
    }
  }
  const bad = map.samples.filter((s) => s.status !== 'ok');
  for (const p of map.problems) console.error(`::error title=Lighthouse 证据（${dir}）::${p}`);
  for (const s of bad.slice(0, 20))
    console.error(`::error title=Lighthouse 证据（${dir}）::样本 #${s.planned} ${s.page} 第 ${s.runIndex} 次：${s.status}；${s.problems.join('；')}`);
  console.log(
    `证据对应表 ${dir}：${map.status}（计划 ${map.planned}，尝试 ${map.attemptsTotal}，被阻止的内部重试 ${map.blockedInternalRetries}，${JSON.stringify(map.counts)}）`,
  );
  process.exit(map.status === 'complete' ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
