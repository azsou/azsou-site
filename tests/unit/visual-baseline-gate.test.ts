// 视觉基线门禁（scripts/ci/visual-baseline-gate.mjs）：缺目录 / 空目录 / 缺必需快照 / 不认识的标题 → 失败；齐全 → 通过。
// 纯函数测试，不起子进程、不跑浏览器。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkBaselines,
  snapshotNameForTitle,
  visualTitlesFromList,
} from '../../scripts/ci/visual-baseline-gate.mjs';

const TITLES = [
  'home @1440 light',
  'home @390 dark',
  'home @844x390 light',
  'home forced-colors',
  'home reduced-motion dark',
];
const NAMES = [
  'home--1440--light.png',
  'home--390--dark.png',
  'home--844x390--light.png',
  'home--1440--forced.png',
  'home--1440--reduced-dark.png',
];

let tmp: string | undefined;
function dirWith(files: string[]) {
  tmp = mkdtempSync(join(tmpdir(), 'vgate-'));
  const d = join(tmp, '__screenshots__');
  mkdirSync(d);
  for (const f of files) writeFileSync(join(d, f), 'x');
  return d;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('snapshotNameForTitle', () => {
  it('与 visual.spec.ts 的 shot() 命名一致', () => {
    expect(TITLES.map(snapshotNameForTitle)).toEqual(NAMES);
  });
  it('不认识的标题返回 null', () => {
    expect(snapshotNameForTitle('home 新格式')).toBeNull();
  });
});

describe('checkBaselines', () => {
  it('基线目录不存在 → 失败', () => {
    const r = checkBaselines({ dir: join(tmpdir(), 'vgate-does-not-exist-xyz'), titles: TITLES });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/不存在/);
  });
  it('基线目录为空 → 失败（不再自动 --update-snapshots=all）', () => {
    const r = checkBaselines({ dir: dirWith([]), titles: TITLES });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/为空/);
  });
  it('目录只有非 png 文件 → 视为空 → 失败', () => {
    const r = checkBaselines({ dir: dirWith(['.gitkeep']), titles: TITLES });
    expect(r.ok).toBe(false);
  });
  it('缺 1 个必需快照 → 失败并列出', () => {
    const r = checkBaselines({ dir: dirWith(NAMES.slice(1)), titles: TITLES });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['home--1440--light.png']);
  });
  it('有不认识的用例标题 → 失败（不能核对就不放行）', () => {
    const r = checkBaselines({ dir: dirWith(NAMES), titles: [...TITLES, 'home 新格式'] });
    expect(r.ok).toBe(false);
    expect(r.unknownTitles).toEqual(['home 新格式']);
  });
  it('用例清单为空 → 失败', () => {
    const r = checkBaselines({ dir: dirWith(NAMES), titles: [] });
    expect(r.ok).toBe(false);
  });
  it('齐全 → 通过；多余文件只告警', () => {
    const r = checkBaselines({ dir: dirWith([...NAMES, 'old--1440--light.png']), titles: TITLES });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual(['old--1440--light.png']);
  });
});

describe('visualTitlesFromList', () => {
  it('只取 visual 项目的用例', () => {
    const list = {
      suites: [
        {
          specs: [],
          suites: [
            {
              specs: [
                { title: 'home @1440 light', tests: [{ projectName: 'visual' }] },
                { title: 'q5', tests: [{ projectName: 'design' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(visualTitlesFromList(list)).toEqual(['home @1440 light']);
  });
});
