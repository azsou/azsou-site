/**
 * 站长 2026-10-27 方案 C（PITR + 独立加密 dump）：独立 dump 必须加密。
 *  - 工作流：缺 BACKUP_PASSPHRASE 直接失败；上传前过 assert-encrypted 闸门；只上传 *.gpg；从不设 BACKUP_ALLOW_PLAINTEXT
 *  - db-backup.sh：没有口令时，远程库一律拒绝（不建目录、不连库）；本机库也要显式 BACKUP_ALLOW_PLAINTEXT=1
 *  - assert-encrypted.sh：明文、改名成 .gpg 的明文、空目录都不过；gpg --symmetric 的产物通过
 * 真实备份 → 加密 → 恢复全流程由 CI db 任务的 restore-drill.sh / drill-negative.sh（E1–E5）覆盖。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const wf = readFileSync(resolve(ROOT, '.github/workflows/db-backup.yml'), 'utf8');
const sh = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync('bash', args, {
    cwd: ROOT,
    env: { ...process.env, BACKUP_PASSPHRASE: '', ...env },
    encoding: 'utf8',
  });

describe('db-backup.yml：强制加密', () => {
  it('检查步骤：缺 SUPABASE_DB_URL 或 BACKUP_PASSPHRASE 任一个都 exit 1，不导出', () => {
    const check = wf.slice(wf.indexOf('name: 检查 Secret'), wf.indexOf('uses: actions/checkout'));
    expect(check).toMatch(/\[ -n "\$SUPABASE_DB_URL" \] \|\| missing=/);
    expect(check).toMatch(/\[ -n "\$BACKUP_PASSPHRASE" \] \|\| missing=/);
    expect(check).toMatch(/exit 1/);
    expect(check).not.toMatch(/::warning/); // 以前缺口令只是警告
  });
  it('上传前有 assert-encrypted 闸门，上传路径只匹配 *.gpg，从不允许明文', () => {
    const gate = wf.indexOf('bash scripts/ops/assert-encrypted.sh backup');
    const upload = wf.indexOf('uses: actions/upload-artifact');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(upload);
    expect(wf).toMatch(/path: backup\/\*\.gpg\s*$/m);
    expect(wf).not.toMatch(/path: backup\/\s*$/m);
    expect(wf).not.toMatch(/BACKUP_ALLOW_PLAINTEXT/);
  });
});

describe('db-backup.sh：没有口令就拒绝', () => {
  it('远程库：退出码 2，不建输出目录（还没连库就停了）', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'bk-')), 'out');
    const r = sh(['scripts/db-backup.sh', 'postgres://u:p@db.example.com:5432/x', out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/必须加密/);
    expect(r.stdout).not.toMatch(/备份完成/);
    expect(existsSync(out)).toBe(false);
  });
  it('远程库：即使设置 BACKUP_ALLOW_PLAINTEXT=1 也拒绝', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'bk-')), 'out');
    const r = sh(['scripts/db-backup.sh', 'postgres://u:p@db.example.com:5432/x', out], {
      BACKUP_ALLOW_PLAINTEXT: '1',
    });
    expect(r.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
  it('本机库：没声明 BACKUP_ALLOW_PLAINTEXT 也拒绝', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'bk-')), 'out');
    const r = sh(['scripts/db-backup.sh', 'postgres://postgres@127.0.0.1:1/x', out], {
      BACKUP_ALLOW_PLAINTEXT: undefined,
    });
    expect(r.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe('assert-encrypted.sh：上传前闸门', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'enc-'));
  const gate = (d: string) => sh(['scripts/ops/assert-encrypted.sh', d]);
  it('明文文件 → 失败', () => {
    const d = dir();
    writeFileSync(join(d, 'azsou-rowcounts-x.tsv'), 'public.t\t1\n');
    expect(gate(d).status).not.toBe(0);
  });
  it('明文改名成 .gpg → 失败（看 OpenPGP 包头，不看扩展名）', () => {
    const d = dir();
    writeFileSync(join(d, 'azsou-public-x.dump.gpg'), 'PGDMP\u0001\u000e\u0000');
    expect(gate(d).status).not.toBe(0);
  });
  it('空目录 / 子目录 → 失败', () => {
    expect(gate(dir()).status).not.toBe(0);
    const d = dir();
    mkdirSync(join(d, 'sub'));
    expect(gate(d).status).not.toBe(0);
  });
  it('gpg --symmetric 的产物 → 通过；混进一个明文 → 失败', () => {
    const d = dir();
    const src = join(mkdtempSync(join(tmpdir(), 'src-')), 'a.tsv');
    writeFileSync(src, 'public.t\t1\n');
    execFileSync('gpg', [
      '--batch',
      '--yes',
      '--quiet',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      'unit-test-only',
      '--symmetric',
      '--cipher-algo',
      'AES256',
      '--output',
      join(d, 'a.tsv.gpg'),
      src,
    ]);
    const ok = gate(d);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/全部加密：1 个/);
    writeFileSync(join(d, 'leak.tsv'), 'x');
    expect(gate(d).status).not.toBe(0);
  });
});
