#!/usr/bin/env node
/**
 * CI：把 Playwright JSON 报告里的「首跑失败、重试通过」（flaky）和硬失败分开报告（docs/CI.md「首跑失败」）。
 *
 * 用法：node scripts/ci/flaky-report.mjs <results.json> [<输出 flaky.json>]
 *  - 每个 flaky 用例：::warning title=首跑失败（flaky）:: 注解（文件:行 + 项目 + 首跑错误第一行）
 *  - 写 $GITHUB_STEP_SUMMARY：flaky 表 + 硬失败表
 *  - 写 flaky.json（上传为产物 flaky-<任务>，保留 30 天，便于逐条跟踪）
 * 退出码：总是 0——硬失败由测试步骤本身让任务失败；这里不重复判定，也不把 flaky 当通过藏起来。
 * 报告不存在（测试步骤超时 / 没跑）：注解说明并退出 0。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [, , input = 'reports/e2e-results.json', output = 'reports/flaky.json'] = process.argv;
const job = [process.env.GITHUB_JOB, process.env.PW_BROWSERS, process.env.PW_SHARD]
  .filter(Boolean)
  .join(' / ');
const summary = (s) =>
  process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

if (!existsSync(input)) {
  console.log(
    `::notice title=没有测试报告::${esc(`${input} 不存在（测试步骤没跑完或超时）；见测试步骤日志`)}`,
  );
  summary(`### ${job || 'e2e'}：没有测试报告\n\n测试步骤没跑完或超时，看上一个步骤的日志。`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(input, 'utf8'));
// 颜色码（ESC[…m）：用 fromCharCode 构造，避免正则里写控制字符
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const flaky = [];
const failed = [];
const firstLine = (r) =>
  (r?.error?.message ?? r?.errors?.[0]?.message ?? '')
    .replace(ANSI, '')
    .split('\n')
    .find((l) => l.trim()) ?? '';

function walk(suite, titles) {
  const t = suite.title && !suite.file?.endsWith(suite.title) ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const row = {
        file: spec.file,
        line: spec.line,
        title: [...t, spec.title].join(' › '),
        project: test.projectName,
        attempts: (test.results ?? []).map((r) => r.status),
        firstError: firstLine(
          (test.results ?? []).find((r) => r.status !== 'passed' && r.status !== 'skipped'),
        ),
      };
      if (test.status === 'flaky') flaky.push(row);
      else if (test.status === 'unexpected') failed.push(row);
    }
  }
  for (const s of suite.suites ?? []) walk(s, t);
}
for (const s of report.suites ?? []) walk(s, []);

for (const f of flaky) {
  console.log(
    `::warning file=${f.file.startsWith('tests/') ? f.file : `${process.env.PW_TESTDIR ?? 'tests/e2e'}/${f.file}`},line=${f.line},title=首跑失败（flaky）::${esc(
      `[${f.project}] ${f.title}\n首跑：${f.firstError}\n重试后通过；按 docs/CI.md 登记并修根因，不算通过`,
    )}`,
  );
}

const st = report.stats ?? {};
let md = `### ${job || 'e2e'}：通过 ${st.expected ?? '?'} · 首跑失败（flaky）${flaky.length} · 失败 ${failed.length} · 跳过 ${st.skipped ?? '?'}\n`;
if (flaky.length) {
  md += `\n#### ⚠️ 首跑失败（flaky）——重试才通过，需要按 docs/CI.md 登记并修根因\n\n| 用例 | 项目 | 各次结果 | 首跑错误 |\n|---|---|---|---|\n`;
  for (const f of flaky)
    md += `| \`${cell(f.file)}:${f.line}\` ${cell(f.title)} | ${f.project} | ${f.attempts.join(' → ')} | ${cell(f.firstError).slice(0, 200)} |\n`;
}
if (failed.length) {
  md += `\n#### ❌ 失败（含重试仍失败）\n\n| 用例 | 项目 | 各次结果 | 错误 |\n|---|---|---|---|\n`;
  for (const f of failed)
    md += `| \`${cell(f.file)}:${f.line}\` ${cell(f.title)} | ${f.project} | ${f.attempts.join(' → ')} | ${cell(f.firstError).slice(0, 200)} |\n`;
}
summary(md);
writeFileSync(
  output,
  JSON.stringify(
    {
      job,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      sha: process.env.GITHUB_SHA,
      flaky,
      failed,
    },
    null,
    2,
  ),
);
console.log(`flaky ${flaky.length} · 失败 ${failed.length} → ${output}`);
