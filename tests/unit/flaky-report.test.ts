import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** scripts/ci/flaky-report.mjs：首跑失败（flaky）与硬失败分开报告（docs/CI.md） */
const script = join(process.cwd(), 'scripts/ci/flaky-report.mjs');

function run(report: unknown | null) {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-'));
  const input = join(dir, 'results.json');
  const output = join(dir, 'flaky.json');
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  if (report) writeFileSync(input, JSON.stringify(report));
  const stdout = execFileSync('node', [script, input, output], {
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_JOB: 'e2e',
      PW_BROWSERS: 'webkit',
      PW_SHARD: '2',
    },
    encoding: 'utf8',
  });
  return {
    stdout,
    summary: readFileSync(summary, 'utf8'),
    out: report
      ? (JSON.parse(readFileSync(output, 'utf8')) as { flaky: unknown[]; failed: unknown[] })
      : null,
  };
}

const result = (status: string, message?: string) => ({ status, ...(message ? { error: { message } } : {}) });
const REPORT = {
  stats: { expected: 2, flaky: 1, unexpected: 1, skipped: 1 },
  suites: [
    {
      title: 'images.spec.ts',
      file: 'images.spec.ts',
      specs: [],
      suites: [
        {
          title: '编辑器图片上传',
          file: 'images.spec.ts',
          specs: [
            {
              title: '工具栏选图 → 发布',
              file: 'images.spec.ts',
              line: 90,
              tests: [
                {
                  projectName: 'webkit-iphone',
                  status: 'flaky',
                  results: [
                    result(
                      'failed',
                      '\u001b[31mError: expect(page).toHaveURL(expected) failed\u001b[39m\n\nExpected …',
                    ),
                    result('passed'),
                  ],
                },
                { projectName: 'webkit-desktop', status: 'expected', results: [result('passed')] },
              ],
            },
            {
              title: '真的坏了',
              file: 'images.spec.ts',
              line: 156,
              tests: [
                {
                  projectName: 'webkit-iphone',
                  status: 'unexpected',
                  results: [result('failed', 'Error: boom'), result('failed', 'Error: boom')],
                },
                { projectName: 'webkit-desktop', status: 'skipped', results: [result('skipped')] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('flaky-report', () => {
  it('flaky 单独打 warning 注解（文件:行、项目、首跑错误第一行，去掉颜色码），硬失败不算 flaky', () => {
    const r = run(REPORT);
    const warnings = r.stdout.split('\n').filter((l) => l.startsWith('::warning'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('file=tests/e2e/images.spec.ts,line=90,title=首跑失败（flaky）::');
    expect(warnings[0]).toContain('[webkit-iphone] 编辑器图片上传 › 工具栏选图 → 发布');
    expect(warnings[0]).toContain('首跑：Error: expect(page).toHaveURL(expected) failed');
    expect(warnings[0]).not.toContain('\u001b[');
    expect(r.out!.flaky).toHaveLength(1);
    expect(r.out!.failed).toHaveLength(1);
  });

  it('任务摘要分两张表：首跑失败（flaky）与失败', () => {
    const { summary } = run(REPORT);
    expect(summary).toContain('### e2e / webkit / 2：通过 2 · 首跑失败（flaky）1 · 失败 1 · 跳过 1');
    expect(summary).toContain('首跑失败（flaky）——重试才通过');
    expect(summary).toContain(
      '| `images.spec.ts:90` 编辑器图片上传 › 工具栏选图 → 发布 | webkit-iphone | failed → passed |',
    );
    expect(summary).toContain('#### ❌ 失败（含重试仍失败）');
    expect(summary).toContain(
      '| `images.spec.ts:156` 编辑器图片上传 › 真的坏了 | webkit-iphone | failed → failed | Error: boom |',
    );
  });

  it('全部通过：没有注解、没有表格', () => {
    const ok = {
      stats: { expected: 1, skipped: 0 },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 't',
              file: 'a.spec.ts',
              line: 1,
              tests: [{ projectName: 'p', status: 'expected', results: [result('passed')] }],
            },
          ],
        },
      ],
    };
    const r = run(ok);
    expect(r.stdout).not.toContain('::warning');
    expect(r.summary).toContain('首跑失败（flaky）0 · 失败 0');
    expect(r.summary).not.toContain('|---|');
  });

  it('没有报告（测试步骤超时 / 没跑）：说明而不是报错', () => {
    const r = run(null);
    expect(r.stdout).toContain('::notice title=没有测试报告::');
    expect(r.summary).toContain('没有测试报告');
  });
});
