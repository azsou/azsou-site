/**
 * 批次 2 跟进 2：备份声明与实际一致（Q06 / 站长 2026-10-27：RPO ≤ 1 小时、RTO ≤ 4 小时、独立加密备份 ≥ 30 天）。
 * 文档 / 后台 / 工作流里描述的备份频率必须与 .github/workflows/db-backup.yml 的 cron 一致；
 * 不能把「每周」写成「每日」，也不能声称已经满足 RPO ≤ 1 小时；差距与待批方案必须写在 BACKUP.md。
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
  it('实际启用的 cron 只有一条，且是每周一次（30 19 * * 0 = 北京时间周一 03:30）', () => {
    const active = [...wf.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
    expect(active).toEqual(['30 19 * * 0']);
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
    expect(wf).toMatch(/\[ -n "\$BACKUP_PASSPHRASE" \] \|\| missing=/);
    expect(wf).not.toMatch(/BACKUP_ALLOW_PLAINTEXT/);
  });
});

describe('文字描述与实际一致', () => {
  it('没有任何地方把本站备份说成「每日 / 每天」', () => {
    for (const p of DOCS) {
      const bad = read(p)
        .split('\n')
        .filter((l) => /(每日|每天|daily).{0,12}备份|备份.{0,12}(每日|每天)/i.test(l))
        // 介绍 Supabase 付费档自带的平台备份可以出现「每日」，但必须点名 Supabase
        .filter((l) => !/Supabase/.test(l));
      expect({ file: p, bad }).toEqual({ file: p, bad: [] });
    }
  });
  it('提到定时备份频率的地方都写「每周一 03:30（北京时间）」', () => {
    for (const p of ['README.md', 'docs/BACKUP.md', 'docs/OPERATIONS.md', 'docs/ACCEPTANCE.md']) {
      expect(read(p), p).toMatch(/每周一 03:30（北京时间）/);
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
