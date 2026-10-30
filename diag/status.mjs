#!/usr/bin/env node
// 最终状态：把各步骤结果、结果文件、证据完整性合成 status.json，并据此决定任务成败。
//   node status.mjs out --write    写 status.json + 追加到 Step Summary（写不出 → 退出 2）
//   node status.mjs out --enforce  读 status.json：overall ≠ ok → 退出 1（放在上传之后，上传成功不能掩盖）
// 任务成功 = 前置核对、采集、解析、结果写出、证据完整全部成功。任务成功只代表采集 / 整理完成，
// 不代表 CLS 达标；CLS 结论只看 results.json / verdict.md 里的 verdict。
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [dir = 'out', mode = '--write'] = process.argv.slice(2);
const statusPath = join(dir, 'status.json');

if (mode === '--enforce') {
  let st;
  try {
    st = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch (e) {
    console.error(`::error::status.json 缺失或损坏，判失败: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(1);
  }
  console.log(`overall=${st.overall}；CLS 结论：${st.verdict ?? '—'}`);
  if (st.overall !== 'ok') {
    console.error(`::error::采集 / 整理未完整完成：${st.failures.join('；')}（不是 CLS 结论）`);
    process.exit(1);
  }
  process.exit(0);
}

const step = (k) => process.env[k] || 'unknown';
const steps = {
  preflight_tree: step('STEP_TREE'),
  preflight_artifact: step('STEP_ARTIFACT'),
  install_lighthouse: step('STEP_INSTALL'),
  environment: step('STEP_ENV'),
  collection: step('STEP_COLLECT'),
  parse: step('STEP_PARSE'),
};
const failures = Object.entries(steps)
  .filter(([, v]) => v !== 'success')
  .map(([k, v]) => `${k}=${v}`);

let results = null;
let resultsStatus = 'missing';
if (existsSync(join(dir, 'results.json'))) {
  try {
    results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    resultsStatus = results?.schema === 'diag-cls/results@r16' ? 'ok' : 'unexpected_schema';
  } catch {
    resultsStatus = 'corrupt';
  }
}
const verdictMd = existsSync(join(dir, 'verdict.md'));
if (resultsStatus !== 'ok') failures.push(`results.json ${resultsStatus}`);
if (!verdictMd) failures.push('verdict.md missing');
const evidence = results?.evidence?.status ?? 'unknown';
if (evidence !== 'complete') {
  const gaps = (results?.evidence?.perSample ?? [])
    .filter((p) => !p.complete)
    .map((p) => `样本${p.sample}: ${(p.gaps ?? []).join('/') || '不完整'}`);
  failures.push(`evidence=${evidence}${gaps.length ? `（${gaps.join('；')}）` : ''}`);
}

const st = {
  schema: 'diag-cls/status@r16',
  overall: failures.length ? 'incomplete' : 'ok',
  meaning: '任务成功只代表采集 / 整理完成，不代表 CLS 达标',
  steps,
  results: resultsStatus,
  verdictMd,
  evidence,
  verdict: results?.verdict?.text ?? null,
  verdictCode: results?.verdict?.code ?? null,
  failures,
};
try {
  writeFileSync(`${statusPath}.tmp`, JSON.stringify(st, null, 2) + '\n');
  renameSync(`${statusPath}.tmp`, statusPath);
} catch (e) {
  console.error(`::error::写 status.json 失败: ${String(e?.message ?? e).split('\n')[0]}`);
  process.exit(2);
}
const summary = [
  `### 诊断任务最终状态：${st.overall === 'ok' ? '采集 / 整理完整' : '采集 / 整理不完整'}`,
  '',
  `- CLS 结论：${st.verdict ?? '没有结论（结果文件缺失）'}`,
  `- 定位证据：${evidence}`,
  `- 失败项：${failures.length ? failures.join('；') : '无'}`,
  `- ${st.meaning}`,
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (verdictMd) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + readFileSync(join(dir, 'verdict.md'), 'utf8'));
}
process.exit(0);
