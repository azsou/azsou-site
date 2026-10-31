#!/usr/bin/env node
/**
 * （r20）Lighthouse 档之间的「正常完成交接」记录。只做两件事：
 *
 *   node scripts/ci/lhci-handoff.mjs write <输出根目录> <档名> <配置> <页数>x<每页次数> <本档退出码> <status> <manifest 结果>
 *     → 写 <输出根目录>/<档名>.handoff.json（先写临时文件再改名）。只由 lhci-tier.sh 在**正常走完全部收尾**之后调用：
 *       summary、verify、evidence-map、exit-codes.json、manifest.sha256 都已经处理完（成功或已记录失败），紧接着就退出。
 *       不在任何 trap / always() / 异常路径里写；本档被中断、超时、被杀 → 没有这个文件。
 *       记录的是本档的退出码与结论（包括性能断言失败），不代表本档通过。
 *   node scripts/ci/lhci-handoff.mjs check <输出根目录> <档名> [<配置> <页数>x<每页次数>]
 *     → 核对交接记录存在且有效；退出码 0 = 有效，1 = 缺失 / 无效（后一档不得 collect），2 = 用法错误。
 *
 * 有效 = 能解析；schema / tier（/ config / expect）一致；exitCode 是 0–4 的整数且与 status 一致（0 ⇔ pass）；
 *        <档名>/exit-codes.json 存在，sha256 = 记录里的 exitCodesSha256，且它的 status 与记录一致；
 *        manifest = "0" 时 <档名>/manifest.sha256 存在且 sha256 = 记录里的 manifestSha256；
 *        GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT 存在时与记录一致（不接受别的运行留下的记录）。
 * （r25）另外要求收尾可核对：manifest = "0"，manifest.sha256 逐文件 sha256 复核通过且正好覆盖 <档名>/ 下全部文件；
 *        exit-codes.json 的 finishing = "0"（summary / verify / evidence-map / exit-codes / manifest 都已生成且可核对）。
 *        lhci-tier.sh 本身在收尾故障时就不写交接记录；这里是第二道核对，收尾故障的档即使留下记录也不放行后一档。
 * 这里不判断本档是否通过；性能断言失败的档照样有有效交接，后一档照常测量（与原 !cancelled() 规则一致）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'az-lhci-handoff/1';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const hpath = (root, tier) => join(root, `${tier}.handoff.json`);

function write([root, tier, cfg, expect, rc, status, manifest]) {
  if (!root || !tier || !cfg || expect === undefined || rc === undefined || !status || !manifest) return usage();
  const d = join(root, tier);
  const codes = join(d, 'exit-codes.json');
  const man = join(d, 'manifest.sha256');
  const rec = {
    schema: SCHEMA,
    tier,
    config: cfg,
    expect,
    exitCode: Number(rc),
    status,
    exitCodesSha256: existsSync(codes) ? sha(codes) : null,
    manifest,
    manifestSha256: manifest === '0' && existsSync(man) ? sha(man) : null,
    github: { runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null },
    writtenAt: new Date().toISOString(),
  };
  const p = hpath(root, tier);
  writeFileSync(`${p}.tmp`, `${JSON.stringify(rec)}\n`);
  renameSync(`${p}.tmp`, p);
  console.log(`交接记录 ${p}：exitCode=${rec.exitCode} status=${rec.status}`);
  return 0;
}

export function checkHandoff(root, tier, cfg, expect) {
  const bad = [];
  const p = hpath(root, tier);
  if (!existsSync(p)) return { ok: false, problems: [`缺 ${p}（${tier} 档没有正常走完收尾：被中断 / 超时 / 被杀，或根本没跑）`] };
  let r;
  try {
    r = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: [`${p} 解析失败：${e?.message ?? e}`] };
  }
  if (!r || typeof r !== 'object') return { ok: false, problems: [`${p} 不是对象`] };
  if (r.schema !== SCHEMA) bad.push(`schema = ${r.schema}`);
  if (r.tier !== tier) bad.push(`tier = ${r.tier}，要求 ${tier}`);
  if (cfg !== undefined && r.config !== cfg) bad.push(`config = ${r.config}，要求 ${cfg}`);
  if (expect !== undefined && r.expect !== expect) bad.push(`expect = ${r.expect}，要求 ${expect}`);
  if (!Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 4) bad.push(`exitCode = ${r.exitCode}`);
  else if ((r.exitCode === 0) !== (r.status === 'pass')) bad.push(`exitCode ${r.exitCode} 与 status ${r.status} 不一致`);
  const codes = join(root, tier, 'exit-codes.json');
  if (!existsSync(codes)) bad.push(`缺 ${codes}`);
  else {
    if (sha(codes) !== r.exitCodesSha256) bad.push('exit-codes.json 的 sha256 与交接记录不符（交接之后被改动）');
    try {
      const c = JSON.parse(readFileSync(codes, 'utf8'));
      if (c.status !== r.status) bad.push(`exit-codes.json status = ${c.status}，交接记录 ${r.status}`);
      if (c.finishing !== '0') bad.push(`exit-codes.json finishing = ${c.finishing}（收尾没有可靠完成）`);
      if (c.manifest !== 'pending' && c.manifest !== '0') bad.push(`exit-codes.json manifest = ${c.manifest}`);
    } catch {
      bad.push('exit-codes.json 解析失败');
    }
  }
  if (r.manifest !== '0') bad.push(`交接记录 manifest = ${r.manifest}（清单没写成，收尾不可核对）`);
  else {
    const man = join(root, tier, 'manifest.sha256');
    if (!existsSync(man) || sha(man) !== r.manifestSha256) bad.push('manifest.sha256 缺失或与交接记录不符');
    else bad.push(...verifyManifest(join(root, tier)));
  }
  for (const [k, e] of [['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']])
    if (process.env[e] && r.github?.[k] !== process.env[e]) bad.push(`github.${k} = ${r.github?.[k]}，本次运行 ${process.env[e]}`);
  return { ok: bad.length === 0, problems: bad, record: r };
}

/** r25：manifest.sha256 逐文件复核，且正好覆盖目录里的全部文件（与 lhci-gate.sh 的核对相同） */
function verifyManifest(d) {
  const bad = [];
  const listed = new Map();
  for (const line of readFileSync(join(d, 'manifest.sha256'), 'utf8').split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) {
      bad.push(`manifest.sha256 有无法解析的行：${line.slice(0, 80)}`);
      continue;
    }
    listed.set(m[2], m[1]);
  }
  const actual = [];
  const walk = (rel) => {
    for (const f of readdirSync(join(d, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(join(d, r)).isDirectory()) walk(r);
      else if (r !== 'manifest.sha256') actual.push(`./${r}`);
    }
  };
  walk('');
  for (const f of actual) if (!listed.has(f)) bad.push(`manifest 没列入 ${f}`);
  for (const [f, h] of listed) {
    if (!existsSync(join(d, f))) bad.push(`manifest 列出的 ${f} 不存在`);
    else if (sha(join(d, f)) !== h) bad.push(`${f} 与 manifest 的 sha256 不符`);
  }
  return bad;
}

function usage() {
  console.error('用法：lhci-handoff.mjs write <根> <档> <配置> <期望> <退出码> <status> <manifest> | check <根> <档> [<配置> <期望>]');
  return 2;
}

function main() {
  const [mode, ...a] = process.argv.slice(2);
  if (mode === 'write') return write(a);
  if (mode === 'check') {
    if (!a[0] || !a[1]) return usage();
    const r = checkHandoff(a[0], a[1], a[2], a[3]);
    for (const p of r.problems) console.error(`::error title=Lighthouse 交接（${a[1]}）::${p}`);
    if (r.ok) console.log(`交接记录有效：${a[1]} exitCode=${r.record.exitCode} status=${r.record.status}`);
    return r.ok ? 0 : 1;
  }
  return usage();
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
