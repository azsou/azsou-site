/**
 * 批次 2 跟进 2：备份声明与实际一致（Q06 / 站长 2026-10-27：RPO ≤ 1 小时、RTO ≤ 4 小时、独立加密备份 ≥ 30 天）。
 * 文档 / 后台 / 工作流里描述的备份频率必须与 .github/workflows/db-backup.yml 的实际触发方式一致；
 * 站长第三轮（2026-10-28）：备份工作流改为受保护、**仅手动触发**；每日定时 / 外部存储 / 监控在 ops/disabled-workflows/ 另行启用。
 * 不能把未启用的定时写成已启用，也不能声称已经满足 RPO ≤ 1 小时；差距与待批方案必须写在 BACKUP.md。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const wf = read('.github/workflows/db-backup.yml');
const DOCS = [
  'README.md',
  'docs/BACKUP.md',
  'docs/OPERATIONS.md',
  'docs/ACCEPTANCE.md',
  'docs/PLAN.md',
  'docs/MIGRATION.md',
  'src/pages/admin/data/index.astro',
];

describe('备份工作流配置', () => {
  it('站长第三轮：没有任何启用的 cron，只有 workflow_dispatch（定时在 ops/disabled-workflows/，默认不启用）', () => {
    const active = [...wf.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
    expect(active).toEqual([]);
    expect(wf).not.toMatch(/^\s*schedule:/m);
    expect(wf).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(wf).toMatch(/environment: backup-production/);
    const daily = read('ops/disabled-workflows/db-backup-daily.yml');
    expect([...daily.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1])).toEqual(['30 19 * * *']);
  });
  it('备份产物保留 ≥ 30 天（站长：独立加密备份至少 30 天）', () => {
    const days = [...wf.matchAll(/retention-days:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) expect(d).toBeGreaterThanOrEqual(30);
  });
  it('所有 run 步骤用 bash -eo pipefail（defaults.run.shell: bash），管道里的失败不会被吞', () => {
    expect(wf).toMatch(/^defaults:\s*\n\s+run:\s*\n\s+shell:\s*bash\s*$/m);
    expect(read('.github/workflows/ci.yml')).toMatch(/^defaults:\s*\n\s+run:\s*\n\s+shell:\s*bash\s*$/m);
  });
  // 站长 2026-10-27 方案 C：比「缺口令时不备份 auth.users」更严——缺口令时整份备份都不做，明文产物永不上传
  it('缺加密口令时整份备份都不做（明文产物永不进 artifact）', () => {
    // 站长第三轮：检查集中在第一个业务步骤 scripts/ops/backup-guard.sh（缺口令 → 失败，不连库）
    const guard = read('scripts/ops/backup-guard.sh');
    expect(guard).toMatch(/for v in [^;]*\bBACKUP_PASSPHRASE\b[^;]*; do/);
    expect(wf.indexOf('bash scripts/ops/backup-guard.sh')).toBeLessThan(
      wf.indexOf('bash scripts/db-backup.sh'),
    );
    expect(wf).not.toMatch(/BACKUP_ALLOW_PLAINTEXT/);
  });
});

describe('文字描述与实际一致', () => {
  it('没有任何地方把本站备份说成已启用的「每日 / 每天 / 每周」定时备份', () => {
    for (const p of DOCS) {
      const bad = read(p)
        .split('\n')
        .filter((l) => /(每日|每天|每周|daily|weekly).{0,12}备份|备份.{0,12}(每日|每天|每周)/i.test(l))
        // 介绍 Supabase 付费档自带的平台备份可以出现「每日」，但必须点名 Supabase；
        // 提到每日模板时必须同一行写明「另行启用 / 未启用 / 默认不启用」
        .filter((l) => !/Supabase|另行启用|未启用|默认不启用|已取消|不再/.test(l));
      expect({ file: p, bad }).toEqual({ file: p, bad: [] });
    }
  });
  it('README / BACKUP / OPERATIONS / ACCEPTANCE 都写明「仅手动触发」与受保护环境 backup-production', () => {
    for (const p of ['README.md', 'docs/BACKUP.md', 'docs/OPERATIONS.md', 'docs/ACCEPTANCE.md']) {
      expect(read(p), p).toMatch(/仅手动触发/);
      expect(read(p), p).toMatch(/backup-production/);
    }
  });
  it('Supabase PITR 写成付费附加项（Pro 本身不含 PITR），不写成「升级 Pro 就有」', () => {
    const ops = read('docs/OPERATIONS.md');
    expect(ops).not.toMatch(/升级 Pro 后另有每日备份与 PITR/);
    expect(read('docs/BACKUP.md')).toMatch(/PITR[^\n]*附加/);
  });
  it('BACKUP.md 写明 RPO ≤ 1 小时 / RTO ≤ 4 小时目标、当前差距与待批方案；不声称已满足', () => {
    const b = read('docs/BACKUP.md');
    expect(b).toMatch(/RPO ≤ 1 小时/);
    expect(b).toMatch(/RTO ≤ 4 小时/);
    expect(b).toMatch(/差距/);
    expect(b).toMatch(/待站长批准/);
    expect(b).not.toMatch(/(已|已经)(满足|达到)\s*RPO/);
  });
});
