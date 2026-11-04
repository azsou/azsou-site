#!/usr/bin/env node
/**
 * 独立备份监控（站长 2026-10-27 方案 C：PITR + 独立加密 dump；本脚本盯「独立加密 dump」那一半）。
 * 由 .github/workflows/backup-monitor.yml 按自己的时间表运行，与备份工作流互不依赖：
 * 备份工作流没跑、跑失败、产物过期被删、或者根本不在默认分支上，这里都会发现。
 *
 * 判定：在备份工作流（默认 db-backup.yml）最近的「成功」运行里，找名为 db-backup-<run_id>、未过期、非空的产物；
 *   - 一个都没有                         → missing（告警）
 *   - 最新一个的时间早于 MAX_AGE_HOURS   → stale（告警）
 *   - 否则                               → ok（如有未关闭的告警 issue，留言并关闭）
 * 告警：打开（或更新）一个带 backup-alert 标签的 issue，并以非 0 退出（Actions 失败通知是第二条通道）。
 *
 * 环境变量：GITHUB_TOKEN、GITHUB_REPOSITORY（owner/repo）、MAX_AGE_HOURS（默认 192 = 每周一次 + 1 天余量；
 *   站长批准更高频率后改成频率 + 余量，例如每日 → 26）、BACKUP_WORKFLOW（默认 db-backup.yml）、ALERT_LABEL（默认 backup-alert）。
 * 本地 / 测试：node scripts/ops/backup-monitor.mjs --fixture <json> [--now <ISO>]  只打印判定，不访问 GitHub。
 * 不读取、不下载任何备份内容，也不需要备份口令。
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_AGE_HOURS = 192;
const HOUR = 3600_000;

/**
 * @param {{ runs: Array<{id:number, status?:string, conclusion:string|null, created_at:string, updated_at?:string, html_url?:string, head_branch?:string}>,
 *           artifacts: Array<{name:string, expired:boolean, created_at:string, size_in_bytes:number, workflow_run?:{id:number}}>,
 *           now: Date|string|number, maxAgeHours?: number, workflowFound?: boolean }} input
 */
export function evaluate({
  runs = [],
  artifacts = [],
  now,
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  workflowFound = true,
}) {
  const t = new Date(now).getTime();
  if (!Number.isFinite(t)) throw new Error('now 无效');
  if (!(maxAgeHours > 0)) throw new Error('MAX_AGE_HOURS 必须是正数');
  const byTime = (a, b) =>
    Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at);
  const done = [...runs].filter((r) => r.status === undefined || r.status === 'completed').sort(byTime);
  const lastRun = done[0] ?? null;
  const success = done.filter((r) => r.conclusion === 'success');
  let latest = null;
  for (const r of success) {
    const a = artifacts.find(
      (x) =>
        x.name === `db-backup-${r.id}` &&
        !x.expired &&
        (x.size_in_bytes ?? 0) > 0 &&
        (x.workflow_run?.id === undefined || x.workflow_run.id === r.id),
    );
    if (a) {
      latest = {
        runId: r.id,
        runUrl: r.html_url ?? null,
        artifact: a.name,
        createdAt: a.created_at,
        bytes: a.size_in_bytes,
      };
      break;
    }
  }
  const failuresSinceLatest = latest
    ? done.filter((r) => r.conclusion !== 'success' && byTime(r, { created_at: latest.createdAt }) < 0).length
    : done.filter((r) => r.conclusion !== 'success').length;
  const base = {
    maxAgeHours,
    lastRun: lastRun && { id: lastRun.id, conclusion: lastRun.conclusion, url: lastRun.html_url ?? null },
    failuresSinceLatest,
  };
  if (!latest) {
    const why = !workflowFound
      ? '备份工作流不在默认分支上（GitHub 只运行默认分支上的定时 / 手动工作流）'
      : success.length
        ? '成功的备份运行都没有可用产物（已过期、被删除或为空）'
        : done.length
          ? `最近 ${done.length} 次备份运行没有一次成功`
          : '备份工作流从未运行';
    return {
      ...base,
      status: 'missing',
      ok: false,
      latest: null,
      ageHours: null,
      title: '备份监控告警：没有可用的独立加密备份',
      message: why,
    };
  }
  const ageHours = Math.round(((t - Date.parse(latest.createdAt)) / HOUR) * 10) / 10;
  if (ageHours > maxAgeHours)
    return {
      ...base,
      status: 'stale',
      ok: false,
      latest,
      ageHours,
      title: `备份监控告警：最新独立加密备份已 ${ageHours} 小时（阈值 ${maxAgeHours}）`,
      message: `最新可用备份 ${latest.artifact} 生成于 ${latest.createdAt}，已超过 ${maxAgeHours} 小时`,
    };
  return {
    ...base,
    status: 'ok',
    ok: true,
    latest,
    ageHours,
    title: '备份监控：正常',
    message: `最新可用备份 ${latest.artifact}（${ageHours} 小时前，阈值 ${maxAgeHours}）`,
  };
}

/** issue 正文（不含任何连接串 / 口令 / 备份内容） */
export function issueBody(r, { repo = '', checkedAt = new Date().toISOString(), runUrl = '' } = {}) {
  const lines = [
    `**状态**：${r.status} **判定**：${r.message}`,
    '',
    `- 检查时间：${checkedAt}`,
    `- 阈值：${r.maxAgeHours} 小时`,
    `- 最新可用备份：${r.latest ? `${r.latest.artifact}（${r.latest.createdAt}，${r.ageHours} 小时前）` : '无'}`,
    `- 最近一次备份运行：${r.lastRun ? `#${r.lastRun.id} ${r.lastRun.conclusion ?? '进行中'}${r.lastRun.url ? ` ${r.lastRun.url}` : ''}` : '无'}`,
    `- 最新可用备份之后失败的运行：${r.failuresSinceLatest} 次`,
    runUrl ? `- 本次监控运行：${runUrl}` : null,
    '',
    '处理：Actions → DB backup → 看最近运行的错误；Secret `SUPABASE_DB_URL` / `BACKUP_PASSPHRASE` 是否存在；工作流是否在默认分支。',
    `见 docs/BACKUP.md §2C「独立监控」。${repo ? `（${repo}）` : ''}`,
    '',
    '<!-- backup-monitor -->',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function gh(path, { method = 'GET', body, token, allow404 = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function main(argv) {
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const maxAgeHours = Number(process.env.MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  if (arg('--fixture')) {
    const fx = JSON.parse(readFileSync(arg('--fixture'), 'utf8'));
    const r = evaluate({ ...fx, now: arg('--now') ?? fx.now, maxAgeHours: fx.maxAgeHours ?? maxAgeHours });
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('需要 GITHUB_TOKEN 与 GITHUB_REPOSITORY');
  const wf = process.env.BACKUP_WORKFLOW || 'db-backup.yml';
  const label = process.env.ALERT_LABEL || 'backup-alert';
  const runsRes = await gh(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=30`, {
    token,
    allow404: true,
  });
  const runs = runsRes?.workflow_runs ?? [];
  const artifacts = [];
  for (const r of runs.filter((x) => x.conclusion === 'success').slice(0, 10)) {
    const a = await gh(`/repos/${repo}/actions/runs/${r.id}/artifacts?per_page=100`, { token });
    artifacts.push(...(a?.artifacts ?? []));
  }
  const r = evaluate({ runs, artifacts, now: Date.now(), maxAgeHours, workflowFound: runsRes !== null });
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const body = issueBody(r, { repo, runUrl });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${r.title}\n\n${body}\n`);
  console.log(`${r.status}: ${r.message}`);
  const open =
    (await gh(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=10`, {
      token,
    })) ?? [];
  const existing = open.find((i) => !i.pull_request);
  if (!r.ok) {
    if (existing) {
      await gh(`/repos/${repo}/issues/${existing.number}`, {
        method: 'PATCH',
        token,
        body: { title: r.title, body },
      });
      await gh(`/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        token,
        body: { body: `仍未恢复：${r.message}` },
      });
      console.log(`已更新告警 issue #${existing.number}`);
    } else {
      const created = await gh(`/repos/${repo}/issues`, {
        method: 'POST',
        token,
        body: { title: r.title, body, labels: [label] },
      });
      console.log(`已打开告警 issue #${created.number}`);
    }
    return 1;
  }
  if (existing) {
    await gh(`/repos/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      token,
      body: { body: `已恢复：${r.message}` },
    });
    await gh(`/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      token,
      body: { state: 'closed' },
    });
    console.log(`已关闭告警 issue #${existing.number}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error title=备份监控运行失败::${e.message}`);
      process.exit(2);
    },
  );
}
