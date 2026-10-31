#!/usr/bin/env node
/**
 * （r24）Lighthouse 一档的逐样本调度台账。只给 lhci-tier.sh 用（LH_EVIDENCE=1 时）：每个计划样本单独调用一次
 * `lhci collect --additive --url=<本样本 URL> --numberOfRuns=1`，调用前后各记一条台账，台账决定「继续下一个样本」还是「停止」。
 *
 *   node lhci-slots.mjs plan  <配置> <页数>x<每页次数>
 *        → 按原顺序（collect.url 依次，每页连续 numberOfRuns 次；@lhci/cli 0.15.1 collect.js 第 130、253–256 行）
 *          输出计划样本，每行「planned<TAB>pageIndex<TAB>runIndex<TAB>url」；配置页数 / 每页次数与期望不符 → 1，不输出
 *   node lhci-slots.mjs begin <档目录(绝对)> <档名> <planned> <pageIndex> <runIndex> <url> <工作目录>
 *        → 追加 begin 记录（含调用前工作目录里的 lhr 数、attempts.jsonl 里的 start 数）。0 = 可以调用；
 *          3 = 拒绝（同一样本已有记录 = 重复调用；顺序不对；上一个样本没有 end）；4 = 台账写不进 / 读不出
 *   node lhci-slots.mjs end   <档目录(绝对)> <档名> <planned> <pageIndex> <runIndex> <url> <工作目录> <collect 退出码> <配置>
 *        → 按本样本身份核对这次 collect 产生的尝试记录与 LHR，并（r25）在放行下一个样本之前核对本样本的**实际产物**
 *          （lhci-evidence.mjs judgeSlotAttempt = 整档对应表的同一套检查：LHR requestedUrl / finalDisplayedUrl /
 *          mainDocumentUrl / finalUrl、trace 与 devtools 日志的归属、能否解析、navigationId ↔ loaderId、formFactor、
 *          前缀资产齐全、stdout LHR ↔ 工作目录 lhr 一一对应），追加 end 记录（含产物文件清单与 sha256）：
 *          0  measured           正好 1 次真实尝试、退出码 0、collect 0、工作目录正好多 1 个 lhr、没有被阻止的重试，
 *                                且产物闸门 measured（产物属于本样本、已留存、可解析）
 *          10 collection-failed  正好 1 次真实尝试、退出码非 0（且不是钩子错误 98）、collect 非 0、工作目录 lhr 数不变，
 *                                且产物闸门 confirmed-failure（可确认的正常测量失败，如真实 NO_NAVSTART：LHR 带 runtimeError、
 *                                身份与已产生的证据可核对）。失败样本原样保留，不重试、不替补；调度器继续下一个计划样本
 *          r25：调用了计划页面却拿回别的页面的 LHR / trace / devtools、子进程资产没写成、证据解析不了或归属不了、
 *          退出码非 0 但分不清是测量失败还是留存失败 → 一律 stop（不再记成 measured / collection-failed 后继续）
 *          20 stop               其他一切：没有尝试 / 多于 1 次真实尝试 / 尝试属于别的样本或 URL 不符 / 钩子错误 /
 *                                stdout·stderr 留存出错 / 没有退出记录 / collect 结果与尝试结果矛盾（如尝试 0 但 collect 非 0，
 *                                可能是 LHR 写盘失败）/ 工作目录 lhr 变少（先前结果被清）或多出不止 1 个 → 调度器停止，不交接
 *          4  台账写不进 / 读不出（调度器停止）
 *   node lhci-slots.mjs stop  <档目录(绝对)> <原因>     → 追加一条 stop 记录（调度器因前提 / 台账问题停止时）
 *   node lhci-slots.mjs portfree <url>                  → 该 URL 的主机端口没有进程在监听 → 0；5 s 内仍在监听 → 1
 *        （每个样本由 LHCI 重新起停 startServerCommand；上一个样本的服务器没退出时不调用，避免新服务器绑不上端口）
 *
 * 台账 <档目录>/slots.jsonl 只追加、不改写、不删除；不读取任何凭据。这里不做测量、不改 LHR、不补 navigationStart。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedFormFactor, judgeSlotAttempt, loadCollect, prefixFn } from './lhci-evidence.mjs';

const [cmd, ...args] = process.argv.slice(2);
const now = () => new Date().toISOString();
const die = (code, msg) => {
  console.error(`::error title=Lighthouse 逐样本调度::${msg}`);
  process.exit(code);
};
const readJsonl = (p, label) => {
  if (!existsSync(p)) return [];
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch (e) {
    die(4, `${label} 读不出：${e?.message ?? e}`);
  }
  return txt
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        return die(4, `${label} 第 ${i + 1} 行解析失败`);
      }
    });
};
const append = (p, rec) => {
  try {
    appendFileSync(p, `${JSON.stringify(rec)}\n`);
  } catch (e) {
    die(4, `台账 ${p} 写不进：${e?.message ?? e}`);
  }
};
const lhrCount = (work) => (existsSync(work) ? readdirSync(work).filter((f) => /^lhr-\d+\.json$/.test(f)).length : 0);
const posInt = (v, k) => {
  if (!/^[1-9][0-9]*$/.test(v ?? '')) die(3, `${k}=${v ?? '无'} 不是正整数`);
  return Number(v);
};
const slotArgs = (a) => {
  const [dir, tier, planned, pageIndex, runIndex, url, work] = a;
  if (!dir || !tier || !url || !work) die(2, `用法错误：${cmd} ${a.join(' ')}`);
  return {
    dir,
    tier,
    planned: posInt(planned, 'planned'),
    pageIndex: posInt(pageIndex, 'pageIndex'),
    runIndex: posInt(runIndex, 'runIndex'),
    url,
    work,
  };
};
const same = (r, s) => r.pageIndex === s.pageIndex && r.runIndex === s.runIndex;

if (cmd === 'plan') {
  const [cfg, expect] = args;
  const m = /^(\d+)x(\d+)$/.exec(expect ?? '');
  if (!cfg || !m) die(2, '用法：plan <配置> <页数>x<每页次数>');
  const abs = resolve(cfg);
  const collect = createRequire(pathToFileURL(abs).href)(abs)?.ci?.collect ?? {};
  const urls = Array.isArray(collect.url) ? collect.url : [];
  const [pages, runs] = [Number(m[1]), Number(m[2])];
  if (urls.length !== pages || collect.numberOfRuns !== runs)
    die(1, `配置 ${urls.length} 页 × ${collect.numberOfRuns} 次 ≠ 期望 ${expect}，不调度`);
  if (urls.some((u) => typeof u !== 'string' || !/^https?:\/\/[^\s]+$/.test(u))) die(1, '配置里有不是 http(s) 的 URL，不调度');
  const lines = [];
  urls.forEach((u, i) => {
    for (let r = 1; r <= runs; r++) lines.push([lines.length + 1, i + 1, r, u].join('\t'));
  });
  process.stdout.write(`${lines.join('\n')}\n`);
} else if (cmd === 'begin') {
  const s = slotArgs(args);
  const ledger = join(s.dir, 'slots.jsonl');
  const recs = readJsonl(ledger, '台账');
  if (recs.some((r) => r.ev !== 'stop' && (same(r, s) || r.planned === s.planned)))
    die(3, `样本 #${s.planned}（第 ${s.pageIndex} 页第 ${s.runIndex} 次）已有台账记录：重复调用，拒绝（失败样本不会被替换）`);
  if (recs.some((r) => r.ev === 'stop')) die(3, '台账已有 stop 记录：本档已停止，不再调用');
  const begins = recs.filter((r) => r.ev === 'begin');
  const ends = recs.filter((r) => r.ev === 'end');
  if (begins.length !== ends.length) die(3, `上一个样本 #${begins[begins.length - 1]?.planned} 没有 end 记录，拒绝继续`);
  if (s.planned !== begins.length + 1) die(3, `样本顺序不对：应为 #${begins.length + 1}，收到 #${s.planned}`);
  const starts = readJsonl(join(s.dir, 'attempts', 'attempts.jsonl'), 'attempts.jsonl').filter((r) => r.ev === 'start');
  append(ledger, {
    ev: 'begin',
    tier: s.tier,
    planned: s.planned,
    pageIndex: s.pageIndex,
    runIndex: s.runIndex,
    url: s.url,
    lhrBefore: lhrCount(s.work),
    attemptsBefore: starts.length,
    t: now(),
  });
} else if (cmd === 'end') {
  const s = slotArgs(args);
  const crc = args[7];
  const cfg = args[8];
  if (!/^[0-9]+$/.test(crc ?? '')) die(2, `collect 退出码 ${crc ?? '无'} 不是整数`);
  if (!cfg) die(2, 'end 缺 <配置>（r25：产物闸门要核对 formFactor）');
  const collectRc = Number(crc);
  const ledger = join(s.dir, 'slots.jsonl');
  const recs = readJsonl(ledger, '台账');
  const last = recs[recs.length - 1];
  if (!last || last.ev !== 'begin' || !same(last, s) || last.planned !== s.planned || last.url !== s.url || last.tier !== s.tier)
    die(4, `台账最后一条不是样本 #${s.planned} 的 begin，无法收尾`);
  const all = readJsonl(join(s.dir, 'attempts', 'attempts.jsonl'), 'attempts.jsonl');
  const starts = all.filter((r) => r.ev === 'start');
  const fresh = starts.slice(last.attemptsBefore);
  const freshIds = new Set(fresh.map((r) => r.attempt));
  // 钩子出错时可能只有 exit（98）没有 start：按 attempt 序号 > 调用前 start 数认领
  const exitsNew = all.filter((r) => r.ev === 'exit' && (freshIds.has(r.attempt) || r.attempt > last.attemptsBefore));
  const exitOf = new Map(exitsNew.map((r) => [r.attempt, r]));
  const real = fresh.filter((r) => !r.retry);
  const blocked = fresh.filter((r) => r.retry);
  const lhrAfter = lhrCount(s.work);
  const delta = lhrAfter - last.lhrBefore;
  const problems = [];
  for (const r of fresh) {
    if (r.tier !== s.tier || r.planned !== s.planned || !same(r, s) || r.url !== s.url)
      problems.push(`尝试 #${r.attempt}（${r.tier} #${r.planned} p${r.pageIndex} r${r.runIndex} ${r.url}）不属于本样本`);
  }
  const hookErr = exitsNew.filter((r) => r.code === 98 || r.reason === 'hook-error');
  if (hookErr.length) problems.push(`钩子出错 ${hookErr.length} 次（${hookErr.map((r) => r.error ?? r.reason).join('；')}）`);
  if (real.length !== 1) problems.push(`真实尝试 ${real.length} 次（应正好 1 次）`);
  const ex = real.length === 1 ? exitOf.get(real[0].attempt) : undefined;
  if (real.length === 1 && !ex) problems.push(`尝试 #${real[0].attempt} 没有退出记录（可能被杀）`);
  if (ex?.teeError) problems.push(`尝试 #${ex.attempt} stdout / stderr 留存出错：${ex.teeError}`);
  if (real.length === 1 && !existsSync(join(s.dir, 'attempts', `attempt-${String(real[0].attempt).padStart(3, '0')}`)))
    problems.push(`缺尝试目录 attempt-${String(real[0].attempt).padStart(3, '0')}`);
  if (delta < 0) problems.push(`工作目录 lhr 从 ${last.lhrBefore} 个变成 ${lhrAfter} 个：先前结果被清除`);
  let outcome = 'stop';
  let candidate = null;
  if (problems.length === 0 && ex) {
    if (collectRc === 0 && ex.code === 0 && delta === 1 && blocked.length === 0) candidate = 'measured';
    else if (collectRc !== 0 && ex.code !== 0 && delta === 0) candidate = 'collection-failed';
    else problems.push(`collect 退出码 ${collectRc}、尝试退出码 ${ex.code}、新增 lhr ${delta} 个、被阻止重试 ${blocked.length} 次：结果矛盾`);
  }
  // r25：放行下一个样本之前的产物闸门（退出码对得上还不够：产物必须属于本样本、已留存、可解析）
  let gate = null;
  if (candidate) {
    let getPrefix = null;
    let formFactor = null;
    try {
      getPrefix = await prefixFn();
    } catch {
      getPrefix = null;
    }
    try {
      formFactor = expectedFormFactor(loadCollect(cfg));
    } catch (e) {
      problems.push(`读不出配置 ${cfg} 的 formFactor：${e?.message ?? e}`);
    }
    const workLhr = existsSync(s.work)
      ? readdirSync(s.work)
          .filter((f) => /^lhr-\d+\.json$/.test(f))
          .map((f) => ({ name: f, sha256: createHash('sha256').update(readFileSync(join(s.work, f))).digest('hex') }))
      : [];
    const claimedLhr = new Set(recs.filter((r) => r.ev === 'end' && r.gate?.lhrFile).map((r) => r.gate.lhrFile));
    const n = real[0].attempt;
    gate = judgeSlotAttempt({
      ad: join(s.dir, 'attempts', `attempt-${String(n).padStart(3, '0')}`),
      attempt: n,
      exitCode: ex.code,
      sample: { planned: s.planned, page: s.url, pageIndex: s.pageIndex, runIndex: s.runIndex, formFactor },
      getPrefix,
      workLhr,
      claimedLhr,
    });
    if (problems.length === 0 && candidate === 'measured' && gate.verdict === 'measured') outcome = 'measured';
    else if (problems.length === 0 && candidate === 'collection-failed' && gate.verdict === 'confirmed-failure') outcome = 'collection-failed';
    else problems.push(`产物闸门 ${gate.verdict}（退出码判定 ${candidate}）：${gate.problems.join('；') || '产物与退出码判定不一致'}`);
  }
  append(ledger, {
    ev: 'end',
    tier: s.tier,
    planned: s.planned,
    pageIndex: s.pageIndex,
    runIndex: s.runIndex,
    url: s.url,
    outcome,
    collectRc,
    attempt: real.length === 1 ? real[0].attempt : null,
    attemptExit: ex ? ex.code : null,
    blockedRetries: blocked.length,
    lhrAfter,
    problems,
    gate,
    t: now(),
  });
  if (outcome === 'measured') process.exit(0);
  if (outcome === 'collection-failed') {
    console.error(`::error title=Lighthouse 逐样本调度::样本 #${s.planned} ${s.url} 第 ${s.runIndex} 次采集失败（尝试 #${ex.attempt} 退出码 ${ex.code}），已记录；不重试、不替补，继续下一个计划样本`);
    process.exit(10);
  }
  die(20, `样本 #${s.planned} ${s.url} 第 ${s.runIndex} 次：${problems.join('；')} → 停止本档采集（不交接）`);
} else if (cmd === 'stop') {
  const [dir, reason] = args;
  if (!dir || !reason) die(2, '用法：stop <档目录> <原因>');
  append(join(dir, 'slots.jsonl'), { ev: 'stop', reason, t: now() });
} else if (cmd === 'portfree') {
  let u;
  try {
    u = new URL(args[0]);
  } catch {
    die(2, `不是 URL：${args[0]}`);
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname;
  const probe = () =>
    new Promise((res) => {
      const c = connect({ host, port });
      c.once('connect', () => {
        c.destroy();
        res(false);
      });
      c.once('error', () => res(true));
    });
  const until = Date.now() + 5000;
  for (;;) {
    if (await probe()) process.exit(0);
    if (Date.now() > until) die(1, `${host}:${port} 5 s 后仍有进程在监听（上一个样本的服务器没退出？），不调用 collect`);
    await new Promise((r) => setTimeout(r, 100));
  }
} else {
  die(2, '用法：lhci-slots.mjs plan|begin|end|stop|portfree …');
}
