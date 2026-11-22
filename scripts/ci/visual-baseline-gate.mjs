#!/usr/bin/env node
/**
 * 视觉基线门禁（push / PR 的 design 任务在跑视觉回归之前执行）。
 *
 * 规则（任一条不满足 → 退出码 1，任务失败）：
 *   1. 基线目录必须存在；
 *   2. 基线目录里必须有 .png（空目录 = 失败，不再自动 --update-snapshots=all）；
 *   3. visual 项目的每个用例都必须有对应的基线文件（按用例标题推出快照名，见 snapshotNameForTitle）；
 *   4. 推不出快照名的用例标题 = 失败（新增了不认识的标题格式时宁可拦下，也不让它「没比就过」）。
 * 多出来的基线文件（没有用例引用）只告警，不失败。
 *
 * 之后 Playwright 用 --update-snapshots=none 比较：即使这里漏判，缺快照也只会失败、不会写入。
 * 候选基线（workflow_dispatch + update_visual）走单独的 visual-candidate 任务，产物不算比较、不算验收。
 *
 * 用法：
 *   PLAYWRIGHT_JSON_OUTPUT_FILE=reports/visual-list.json \
 *     npx playwright test -c playwright.design.config.ts --project=visual --list --reporter=json
 *   node scripts/ci/visual-baseline-gate.mjs --list reports/visual-list.json \
 *     --dir tests/visual/__screenshots__ [--out reports/visual-gate.json]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 与 tests/visual/visual.spec.ts 的 shot() 命名一致；不认识的标题返回 null。 */
export function snapshotNameForTitle(title) {
  let m = /^(\S+) @(\d+(?:x\d+)?) (light|dark)$/.exec(title);
  if (m) return `${m[1]}--${m[2]}--${m[3]}.png`;
  m = /^(\S+) forced-colors$/.exec(title);
  if (m) return `${m[1]}--1440--forced.png`;
  m = /^(\S+) reduced-motion dark$/.exec(title);
  if (m) return `${m[1]}--1440--reduced-dark.png`;
  return null;
}

/** 从 Playwright --list --reporter=json 的输出里取 visual 项目的全部用例标题。 */
export function visualTitlesFromList(listJson, project = 'visual') {
  const titles = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) if (t.projectName === project) titles.push(spec.title);
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of listJson.suites ?? []) walk(s);
  return titles;
}

/**
 * @param {{ dir: string, titles: string[] }} p
 * @returns {{ ok: boolean, reasons: string[], required: number, present: number, missing: string[], extra: string[], unknownTitles: string[], duplicates: string[] }}
 */
export function checkBaselines({ dir, titles }) {
  const reasons = [];
  const res = {
    ok: false,
    reasons,
    required: 0,
    present: 0,
    missing: [],
    extra: [],
    unknownTitles: [],
    duplicates: [],
  };
  if (!Array.isArray(titles) || titles.length === 0) {
    reasons.push('visual 项目列出 0 个用例（--list 失败或项目被改名），无法核对基线');
  }
  const required = new Map();
  for (const t of titles ?? []) {
    const n = snapshotNameForTitle(t);
    if (!n) {
      res.unknownTitles.push(t);
      continue;
    }
    if (required.has(n)) res.duplicates.push(n);
    required.set(n, t);
  }
  res.required = required.size;
  if (res.unknownTitles.length)
    reasons.push(`${res.unknownTitles.length} 个用例标题推不出快照名（先更新 snapshotNameForTitle）`);
  if (res.duplicates.length) reasons.push(`${res.duplicates.length} 个快照名重复`);

  let files = null;
  if (!existsSync(dir)) reasons.push(`基线目录不存在：${dir}`);
  else if (!statSync(dir).isDirectory()) reasons.push(`基线路径不是目录：${dir}`);
  else {
    files = readdirSync(dir).filter((f) => f.endsWith('.png'));
    if (files.length === 0) reasons.push(`基线目录为空（0 个 .png）：${dir}`);
  }
  if (files) {
    const have = new Set(files);
    res.present = files.length;
    for (const n of required.keys()) if (!have.has(n)) res.missing.push(n);
    for (const f of files) if (!required.has(f)) res.extra.push(f);
    res.missing.sort();
    res.extra.sort();
    if (files.length > 0 && res.missing.length) reasons.push(`缺 ${res.missing.length} 个必需快照`);
  }
  res.ok = reasons.length === 0;
  return res;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const listPath = arg('--list');
  const dir = arg('--dir') ?? 'tests/visual/__screenshots__';
  const out = arg('--out');
  if (!listPath) {
    console.error(
      '用法：visual-baseline-gate.mjs --list <playwright-list.json> --dir <基线目录> [--out <结果.json>]',
    );
    process.exit(2);
  }
  let titles = [];
  try {
    titles = visualTitlesFromList(JSON.parse(readFileSync(listPath, 'utf8')));
  } catch (e) {
    console.error(`::error title=视觉基线门禁::读不了用例清单 ${listPath}：${e.message}`);
    process.exit(1);
  }
  const res = checkBaselines({ dir, titles });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ dir, ...res }, null, 2) + '\n');
  }
  console.log(
    `视觉基线门禁：用例 ${titles.length}，必需快照 ${res.required}，目录里 ${res.present}，缺 ${res.missing.length}，多余 ${res.extra.length}`,
  );
  for (const f of res.extra) console.log(`::warning title=视觉基线多余::${dir}/${f} 没有用例引用`);
  if (!res.ok) {
    for (const r of res.reasons) console.log(`::error title=视觉基线门禁（失败）::${r}`);
    for (const m of res.missing.slice(0, 50)) console.log(`  缺：${m}`);
    for (const t of res.unknownTitles.slice(0, 50)) console.log(`  未知标题：${t}`);
    console.log(
      '不会自动生成基线。需要新基线时：workflow_dispatch 勾选 update_visual → visual-candidate 产物 → 人工审阅后提交。',
    );
    process.exit(1);
  }
  console.log('✓ 视觉基线齐全（之后以 --update-snapshots=none 比较）');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
