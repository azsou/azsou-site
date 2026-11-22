// Lighthouse 两档产物隔离、证据完整性与退出码（scripts/ci/lhci-tier.sh + lhci-gate.sh + lhci-verify.mjs）：
// 用假 lhci（tests/fixtures/lhci/fake-lhci.mjs），不起浏览器；文件系统故障是真实的（在输出路径上预先放同名目录让写入 / 复制失败）。
// 每个用例起 bash 子进程，按项目约定单独给 30s。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTier } from '../../scripts/ci/lhci-verify.mjs';

const ROOT = resolve(__dirname, '../..');
const TIER = join(ROOT, 'scripts/ci/lhci-tier.sh');
const GATE = join(ROOT, 'scripts/ci/lhci-gate.sh');
const FAKE = `node ${join(ROOT, 'tests/fixtures/lhci/fake-lhci.mjs')}`;
const T = 30_000;
// 测试用配置：mobile 3 页 × 3 次，desktop 2 页 × 1 次（真实配置是 32×3 / 12×1，结构相同）
const SPEC: Record<string, { pages: number; runs: number }> = {
  mobile: { pages: 3, runs: 3 },
  desktop: { pages: 2, runs: 1 },
};
const expectOf = (name: string) => `${SPEC[name].pages}x${SPEC[name].runs}`;
const GATE_ARGS = Object.keys(SPEC).map((n) => `${n}=${n}.cjs:${expectOf(n)}`);

let cwd = '';
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = '';
});
function setup() {
  cwd = mkdtempSync(join(tmpdir(), 'lhci-tier-'));
  for (const [name, { pages, runs }] of Object.entries(SPEC)) {
    const port = name === 'mobile' ? 4322 : 4324;
    const urls = ['/', '/apps/', '/search/', '/login/']
      .slice(0, pages)
      .map((p) => `http://127.0.0.1:${port}${p}`);
    writeFileSync(
      join(cwd, `${name}.cjs`),
      `module.exports = { ci: { collect: { url: ${JSON.stringify(urls)}, numberOfRuns: ${runs} } } };\n`,
    );
  }
  return cwd;
}
type Env = Record<string, string>;
function tier(name: string, env: Env = {}) {
  const r = spawnSync('bash', [TIER, name, `${name}.cjs`, 'lhci-out', expectOf(name)], {
    cwd,
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', LHCI: FAKE, FAKE_OUT: join('lhci-out', name), ...env },
    encoding: 'utf8',
  });
  return r.status;
}
function gate(args: string[] = GATE_ARGS) {
  return spawnSync('bash', [GATE, 'lhci-out', ...args], { cwd, encoding: 'utf8' }).status;
}
const out = (name: string, ...p: string[]) => join(cwd, 'lhci-out', name, ...p);
const codes = (name: string) => JSON.parse(readFileSync(out(name, 'exit-codes.json'), 'utf8'));
const summary = (name: string) => JSON.parse(readFileSync(out(name, 'summary.json'), 'utf8'));
const lhrs = (name: string) => readdirSync(out(name, 'raw')).filter((f) => f.startsWith('lhr-'));
/** 退出码与 exit-codes.json 的结论必须一致 */
function consistent(name: string, rc: number | null) {
  expect(codes(name).status === 'pass').toBe(rc === 0);
}

describe('lhci-tier.sh / lhci-gate.sh：正常与失败不互相掩盖', () => {
  it('完整通过：每步 0、样本数正确、assertion-results 为合法空数组、gate 0', { timeout: T }, () => {
    setup();
    const m = tier('mobile');
    const d = tier('desktop');
    expect([m, d]).toEqual([0, 0]);
    consistent('mobile', m);
    expect(codes('mobile')).toMatchObject({
      collect: '0',
      assert: '0',
      assertionResultsFile: 'present',
      archive: '0',
      upload: '0',
      cleanup: '0',
      summary: '0',
      verify: '0',
      status: 'pass',
      expect: '3x3',
    });
    expect(lhrs('mobile')).toHaveLength(9);
    expect(lhrs('desktop')).toHaveLength(2);
    const s = summary('mobile');
    expect(s.assertionResults).toBe('present-empty');
    expect(s.failedOrWarnAssertionEntries).toBe(0);
    expect(s).not.toHaveProperty('assertionCount');
    expect(existsSync(join(cwd, '.lighthouseci'))).toBe(false);
    expect(gate()).toBe(0);
  });

  it('后一档断言失败：本档 1，先跑的档完好，总结论失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    const d = tier('desktop', { FAKE_ASSERT_RC: '1', FAKE_CLS: '0.08' });
    expect(d).toBe(1);
    consistent('desktop', d);
    expect(codes('desktop')).toMatchObject({ assert: '1', status: 'fail' });
    expect(summary('desktop').failedAssertions).toHaveLength(1);
    expect(summary('desktop').failedOrWarnAssertionEntries).toBe(1);
    expect(codes('mobile').status).toBe('pass');
    expect(gate()).toBe(1);
  });

  it('先跑的档失败不被后一档的通过掩盖', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_ASSERT_RC: '1' })).toBe(1);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('collect 失败：assert not-run，本档失败', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_COLLECT_RC: '1' });
    expect(m).toBe(1);
    consistent('mobile', m);
    expect(codes('mobile')).toMatchObject({ collect: '1', assert: 'not-run', status: 'fail' });
  });

  it('upload 失败也算失败', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_UPLOAD_RC: '1' });
    expect(m).toBe(1);
    consistent('mobile', m);
  });

  it('同名档再跑一次 → 拒绝（2），原结果一个字节不变', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    const before = readFileSync(out('mobile', 'manifest.sha256'), 'utf8');
    const codesBefore = readFileSync(out('mobile', 'exit-codes.json'), 'utf8');
    expect(tier('mobile', { FAKE_ASSERT_RC: '1' })).toBe(2);
    expect(readFileSync(out('mobile', 'manifest.sha256'), 'utf8')).toBe(before);
    expect(readFileSync(out('mobile', 'exit-codes.json'), 'utf8')).toBe(codesBefore);
    expect(gate()).toBe(1); // desktop 缺档
  });

  it('工作目录 .lighthouseci 有残留 → 拒绝（2），不删它，只写一份拒绝记录', { timeout: T }, () => {
    setup();
    mkdirSync(join(cwd, '.lighthouseci'));
    writeFileSync(join(cwd, '.lighthouseci/lhr-old.json'), '{}');
    expect(tier('mobile')).toBe(2);
    expect(existsSync(join(cwd, '.lighthouseci/lhr-old.json'))).toBe(true);
    expect(codes('mobile')).toMatchObject({ status: 'refused', reason: 'workdir-present' });
    expect(gate()).toBe(1);
  });

  it('归档后被改动 / 多出未列入清单的文件 → 总结论失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(0);
    writeFileSync(out('desktop', 'raw', 'extra.json'), '{}');
    expect(gate()).toBe(1);
    rmSync(out('desktop', 'raw', 'extra.json'));
    expect(gate()).toBe(0);
    writeFileSync(out('mobile', 'raw', lhrs('mobile')[0]), '{"tampered":true}');
    expect(gate()).toBe(1);
  });
});

describe('r14：文件操作故障一律记录 + 非 0，绝不清理先前证据', () => {
  it(
    '归档复制部分失败：本档 3，.lighthouseci 原样保留；后一档拒绝启动且不动先前证据；gate 失败',
    { timeout: T },
    () => {
      setup();
      const m = tier('mobile', { FAKE_SABOTAGE: 'copy' });
      expect(m).toBe(3);
      consistent('mobile', m);
      expect(codes('mobile')).toMatchObject({
        archive: 'copy-failed',
        cleanup: 'kept-unarchived',
        status: 'fail',
      });
      // 原始数据没丢：工作目录里 9 个 LHR 都在
      expect(readdirSync(join(cwd, '.lighthouseci')).filter((f) => f.startsWith('lhr-'))).toHaveLength(9);
      const mobileManifest = readFileSync(out('mobile', 'manifest.sha256'), 'utf8');
      const d = tier('desktop');
      expect(d).toBe(2);
      expect(codes('desktop')).toMatchObject({ status: 'refused' });
      expect(readdirSync(join(cwd, '.lighthouseci')).filter((f) => f.startsWith('lhr-'))).toHaveLength(9);
      expect(readFileSync(out('mobile', 'manifest.sha256'), 'utf8')).toBe(mobileManifest);
      expect(gate()).toBe(1);
    },
  );

  it(
    'assert 退出 0 但 assertion-results.json 缺失：本档失败（缺失 ≠ 空数组），gate 失败',
    { timeout: T },
    () => {
      setup();
      const m = tier('mobile', { FAKE_NO_ASSERT_FILE: '1' });
      expect(m).toBe(1);
      consistent('mobile', m);
      expect(codes('mobile')).toMatchObject({ assert: '0', assertionResultsFile: 'missing', verify: '1' });
      expect(summary('mobile').assertionResults).toBe('missing');
      expect(summary('mobile').failedOrWarnAssertionEntries).toBeNull();
      expect(tier('desktop')).toBe(0);
      expect(gate()).toBe(1);
    },
  );

  it('summary 写不进去：本档 3，exit-codes 记 summary=fail、status=fail', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_SABOTAGE: 'summary' });
    expect(m).toBe(3);
    consistent('mobile', m);
    expect(codes('mobile')).toMatchObject({ summary: 'fail', status: 'fail' });
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('manifest 写不成：本档 3，exit-codes 改记 manifest=fail、status=fail，gate 失败', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_SABOTAGE: 'manifest' });
    expect(m).toBe(3);
    consistent('mobile', m);
    expect(codes('mobile')).toMatchObject({ manifest: 'fail', status: 'fail' });
    expect(statSync(out('mobile', 'manifest.sha256')).isDirectory()).toBe(true);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('exit-codes.json 写不进去：本档 3，gate 失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_SABOTAGE: 'exitcodes' })).toBe(3);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });
});

describe('r14：证据完整性（不只是哈希）', () => {
  it('样本不足（少 1 个）：collect / assert 都是 0 也判失败', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_DROP: '1' });
    expect(m).toBe(1);
    consistent('mobile', m);
    expect(codes('mobile')).toMatchObject({ collect: '0', assert: '0', verify: '1' });
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('runtimeError 样本不会被中位数过滤成通过', { timeout: T }, () => {
    setup();
    const m = tier('mobile', { FAKE_RUNTIME_ERROR: '1' });
    expect(m).toBe(1);
    consistent('mobile', m);
    expect(summary('mobile').pages[0].runtimeErrors).toBe(1);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('缺必需指标（LCP）→ 失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile', { FAKE_MISSING_METRIC: '1' })).toBe(1);
    expect(tier('desktop')).toBe(0);
    expect(gate()).toBe(1);
  });

  it('页面不在配置清单里 → 失败', { timeout: T }, () => {
    setup();
    expect(tier('desktop', { FAKE_URLS: 'http://127.0.0.1:4324/,http://127.0.0.1:4324/other/' })).toBe(1);
  });

  it('gate 的期望与配置不符（配置页数被改小）→ 失败；只给档名的旧写法 → 失败', { timeout: T }, () => {
    setup();
    expect(tier('mobile')).toBe(0);
    expect(tier('desktop')).toBe(0);
    expect(gate(['mobile=mobile.cjs:4x3', 'desktop=desktop.cjs:2x1'])).toBe(1);
    expect(gate(['mobile=mobile.cjs:3x1', 'desktop=desktop.cjs:2x1'])).toBe(1);
    expect(gate(['mobile', 'desktop'])).toBe(1);
    expect(gate([])).toBe(1);
    expect(gate()).toBe(0);
  });

  it('verifyTier：合法 [] 通过，缺失 / 不可解析 / 非数组分别记录且失败', { timeout: T }, () => {
    setup();
    expect(tier('desktop')).toBe(0);
    const dir = out('desktop');
    const cfg = join(cwd, 'desktop.cjs');
    const ar = join(dir, 'raw', 'assertion-results.json');
    expect(verifyTier(dir, cfg, 2, 1)).toMatchObject({ ok: true, assertionResults: 'present-empty' });
    rmSync(ar);
    expect(verifyTier(dir, cfg, 2, 1)).toMatchObject({ ok: false, assertionResults: 'missing' });
    writeFileSync(ar, '[{');
    expect(verifyTier(dir, cfg, 2, 1)).toMatchObject({ ok: false, assertionResults: 'unparseable' });
    writeFileSync(ar, '{}');
    expect(verifyTier(dir, cfg, 2, 1)).toMatchObject({ ok: false, assertionResults: 'not-array' });
    writeFileSync(ar, JSON.stringify([{ auditId: 'x', level: 'warn', passed: false }]));
    expect(verifyTier(dir, cfg, 2, 1)).toMatchObject({
      ok: true,
      assertionResults: 'present',
      failedOrWarnAssertionEntries: 1,
      failedErrorLevelEntries: 0,
    });
  });
});
