// Lighthouse 两档产物隔离与退出码（scripts/ci/lhci-tier.sh + lhci-gate.sh）：用假 lhci（tests/fixtures/lhci/fake-lhci.mjs），不起浏览器。
// 每个用例起 bash 子进程，按项目约定单独给 30s。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const TIER = join(ROOT, 'scripts/ci/lhci-tier.sh');
const GATE = join(ROOT, 'scripts/ci/lhci-gate.sh');
const FAKE = `node ${join(ROOT, 'tests/fixtures/lhci/fake-lhci.mjs')}`;
const T = 30_000;

let cwd = '';
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = '';
});
function setup() {
  cwd = mkdtempSync(join(tmpdir(), 'lhci-tier-'));
  return cwd;
}
function tier(name: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [TIER, name, `${name}.cjs`], {
    cwd,
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', LHCI: FAKE, ...env },
    encoding: 'utf8',
  });
  return r.status;
}
function gate() {
  return spawnSync('bash', [GATE], { cwd, encoding: 'utf8' }).status;
}
const codes = (name: string) =>
  JSON.parse(readFileSync(join(cwd, 'lhci-out', name, 'exit-codes.json'), 'utf8'));
const lhrs = (name: string) =>
  readdirSync(join(cwd, 'lhci-out', name, 'raw')).filter((f) => f.startsWith('lhr-'));

describe('lhci-tier.sh / lhci-gate.sh', () => {
  it('两档都通过：各自目录、原始 LHR 互不覆盖、结论 0', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_URLS: 'http://127.0.0.1:4322/,http://127.0.0.1:4322/apps/' })).toBe(0);
    expect(tier('desktop', { FAKE_URLS: 'http://127.0.0.1:4324/' })).toBe(0);
    expect(lhrs('mobile')).toHaveLength(2);
    expect(lhrs('desktop')).toHaveLength(1);
    expect(existsSync(join(cwd, 'lhci-out/mobile/raw/assertion-results.json'))).toBe(true);
    expect(existsSync(join(cwd, 'lhci-out/desktop/raw/assertion-results.json'))).toBe(true);
    expect(existsSync(join(cwd, 'lhci-out/mobile/reports/manifest.json'))).toBe(true);
    expect(existsSync(join(cwd, '.lighthouseci'))).toBe(false);
    expect(gate()).toBe(0);
  });

  it('后一档断言失败：本档非 0，先跑的档完好，总结论失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    expect(tier('desktop', { FAKE_ASSERT_RC: '1', FAKE_CLS: '0.08' })).toBe(1);
    expect(codes('desktop')).toMatchObject({ assert: '1', status: 'fail' });
    const s = JSON.parse(readFileSync(join(cwd, 'lhci-out/desktop/summary.json'), 'utf8'));
    expect(s.failedAssertions).toHaveLength(1);
    expect(codes('mobile').status).toBe('pass');
    expect(gate()).toBe(1);
  });

  it('先跑的档失败也不被后一档的通过掩盖', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_ASSERT_RC: '1' })).toBe(1);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('collect 失败：不做断言（not-run），本档失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_COLLECT_RC: '1' })).toBe(1);
    expect(codes('mobile')).toMatchObject({ collect: '1', assert: 'not-run', status: 'fail' });
  });

  it('upload 失败也算失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_UPLOAD_RC: '1' })).toBe(1);
  });

  it('同名档再跑一次 → 拒绝（2），原结果不变', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    const before = readFileSync(join(cwd, 'lhci-out/mobile/manifest.sha256'), 'utf8');
    expect(tier('mobile', { FAKE_ASSERT_RC: '1' })).toBe(2);
    expect(readFileSync(join(cwd, 'lhci-out/mobile/manifest.sha256'), 'utf8')).toBe(before);
    expect(gate()).toBe(1); // desktop 缺档
  });

  it('工作目录 .lighthouseci 有残留 → 拒绝（2），不替别人删', { timeout: T }, () => {
    setup();
    mkdirSync(join(cwd, '.lighthouseci'));
    writeFileSync(join(cwd, '.lighthouseci/lhr-old.json'), '{}');
    expect(tier('mobile')).toBe(2);
    expect(existsSync(join(cwd, '.lighthouseci/lhr-old.json'))).toBe(true);
  });

  it('归档后被改动 → 总结论失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    expect(tier('desktop')).toBe(0);
    const f = join(cwd, 'lhci-out/mobile/raw', lhrs('mobile')[0]);
    writeFileSync(f, '{"tampered":true}');
    expect(gate()).toBe(1);
  });
});
