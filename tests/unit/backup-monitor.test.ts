/**
 * 独立备份监控（站长 2026-10-27 方案 C）：scripts/ops/backup-monitor.mjs 的判定逻辑与工作流配置。
 * 夹具在 tests/fixtures/backup-monitor/（GitHub API 的 workflow_runs / artifacts 形状，时间写死）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 运维脚本是纯 .mjs，没有类型声明
import { evaluate, issueBody, DEFAULT_MAX_AGE_HOURS } from '../../scripts/ops/backup-monitor.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const FX = (n: string) => resolve(ROOT, 'tests/fixtures/backup-monitor', `${n}.json`);
const load = (n: string) => JSON.parse(readFileSync(FX(n), 'utf8'));
const run = (n: string) => evaluate(load(n));

describe('判定', () => {
  it('最新成功运行有未过期产物、且在阈值内 → ok', () => {
    const r = run('ok');
    expect(r).toMatchObject({ status: 'ok', ok: true, latest: { runId: 3, artifact: 'db-backup-3' } });
    expect(r.ageHours).toBeCloseTo(16.4, 1);
  });
  it('最新可用产物超过阈值 → stale（并数出之后失败的运行）', () => {
    const r = run('stale');
    expect(r).toMatchObject({ status: 'stale', ok: false, latest: { runId: 3 }, failuresSinceLatest: 1 });
    expect(r.ageHours).toBeGreaterThan(192);
    expect(r.title).toMatch(/已 [\d.]+ 小时（阈值 192）/);
  });
  it('阈值可调：同一份数据阈值 12 小时 → stale', () => {
    expect(evaluate({ ...load('ok'), maxAgeHours: 12 }).status).toBe('stale');
  });
  it('从未运行 / 全部失败 / 产物过期 / 工作流不在默认分支 → missing，原因各不相同', () => {
    const msgs = ['missing-never-ran', 'missing-all-failed', 'missing-expired', 'missing-workflow'].map(
      (n) => {
        const r = run(n);
        expect(r).toMatchObject({ status: 'missing', ok: false, latest: null });
        return r.message;
      },
    );
    expect(msgs[0]).toMatch(/从未运行/);
    expect(msgs[1]).toMatch(/最近 2 次备份运行没有一次成功/);
    expect(msgs[2]).toMatch(/没有可用产物/);
    expect(msgs[3]).toMatch(/不在默认分支/);
  });
  it('空产物不算备份、进行中的运行不算成功：跳过它们取上一个可用的', () => {
    expect(run('latest-success-empty-artifact')).toMatchObject({ status: 'ok', latest: { runId: 3 } });
  });
  it('默认阈值 192 小时（每周一次 + 1 天余量）；参数非法时直接报错', () => {
    expect(DEFAULT_MAX_AGE_HOURS).toBe(192);
    expect(() => evaluate({ runs: [], artifacts: [], now: 'x' })).toThrow();
    expect(() => evaluate({ runs: [], artifacts: [], now: 0, maxAgeHours: 0 })).toThrow();
  });
});

describe('告警 issue 正文', () => {
  it('写明状态、阈值、最新备份与处理办法，不含任何连接串 / 口令', () => {
    const body = issueBody(run('stale'), { repo: 'azsou/azsou-site', checkedAt: '2026-11-10T12:00:00Z' });
    expect(body).toMatch(/\*\*状态\*\*：stale/);
    expect(body).toMatch(/阈值：192 小时/);
    expect(body).toMatch(/db-backup-3/);
    expect(body).toMatch(/BACKUP\.md §2C/);
    expect(body).not.toMatch(/postgres(ql)?:\/\/|PASSPHRASE=|password/i);
  });
});

describe('命令行（--fixture，不访问 GitHub）', () => {
  const cli = (n: string) => {
    try {
      return {
        code: 0,
        out: execFileSync('node', ['scripts/ops/backup-monitor.mjs', '--fixture', FX(n)], {
          cwd: ROOT,
        }).toString(),
      };
    } catch (e) {
      const x = e as { status: number; stdout: Buffer };
      return { code: x.status, out: x.stdout.toString() };
    }
  };
  it('ok → 退出码 0；stale / missing → 退出码 1（Actions 失败通知是第二条通道）', () => {
    expect(cli('ok')).toMatchObject({ code: 0 });
    expect(JSON.parse(cli('stale').out).status).toBe('stale');
    expect(cli('stale').code).toBe(1);
    expect(cli('missing-never-ran').code).toBe(1);
  });
});

describe('监控工作流配置（.github/workflows/backup-monitor.yml）', () => {
  const wf = readFileSync(resolve(ROOT, '.github/workflows/backup-monitor.yml'), 'utf8');
  it('独立的定时 + 手动触发，与备份工作流时间表不同', () => {
    const crons = [...wf.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
    expect(crons.length).toBe(1);
    expect(crons[0]).not.toBe('30 19 * * 0');
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).not.toMatch(/workflow_run:/); // 不依赖备份工作流触发——它不跑时监控照样跑
  });
  it('最小权限：读 actions、写 issues；不读任何备份 Secret', () => {
    expect(wf).toMatch(/actions:\s*read/);
    expect(wf).toMatch(/issues:\s*write/);
    expect(wf).not.toMatch(/SUPABASE_DB_URL|BACKUP_PASSPHRASE/);
    expect(wf).toMatch(/node scripts\/ops\/backup-monitor\.mjs/);
  });
});
