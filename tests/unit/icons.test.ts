/**
 * D04 / T009：图标单一来源与许可登记。
 *  - UI 图标都是 Lucide 子集的线性图形（只用基本形状，不自带 fill / stroke，统一由 Icon.astro 包装）
 *  - 搜索结果行的类型图标与 src/lib/lucide.ts 逐字一致（不再有手写的分叉副本）
 *  - icon-manifest.json 里的每个应用 / 品牌图标都在 docs/ICON-LICENSES.md 登记，且登记文件是最新生成的
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LUCIDE } from '@/lib/lucide';
import { TYPE_ICON } from '@/scripts/search/render';

describe('D04 图标', () => {
  it('Lucide 子集只用基本形状，不自带颜色 / 线宽（由 Icon.astro 统一 24 网格、描边 1.75）', () => {
    for (const [name, body] of Object.entries(LUCIDE)) {
      const tags = [...body.matchAll(/<([a-z]+)/g)].map((m) => m[1]);
      expect(
        tags.filter((t) => !['path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse'].includes(t)),
        name,
      ).toEqual([]);
      expect(/\b(fill|stroke|stroke-width|style)=/.test(body), name).toBe(false);
    }
    const icon = fs.readFileSync('src/components/Icon.astro', 'utf8');
    expect(icon).toContain('viewBox="0 0 24 24"');
    expect(icon).toContain("'1.75'");
  });
  it('搜索结果的类型图标与 Lucide 表逐字一致', () => {
    const values = new Set<string>(Object.values(LUCIDE));
    expect(
      Object.entries(TYPE_ICON)
        .filter(([, v]) => !values.has(v))
        .map(([k]) => k),
    ).toEqual([]);
  });
  it('每个应用 / 品牌图标都有来源与许可登记，登记文件与生成结果一致', () => {
    const manifest = JSON.parse(fs.readFileSync('src/data/icon-manifest.json', 'utf8')) as Record<
      string,
      unknown
    >;
    const doc = fs.readFileSync('docs/ICON-LICENSES.md', 'utf8');
    // Prettier 会对齐表格列宽，所以按「| `slug` <空格若干> |」匹配
    expect(Object.keys(manifest).filter((k) => !new RegExp(`\\|\\s*\`${k}\`\\s*\\|`).test(doc))).toEqual([]);
    expect(doc).toMatch(/Lucide[\s\S]*ISC/);
    expect(() =>
      execFileSync('node', ['scripts/design/icon-licenses.mjs', '--check'], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});
