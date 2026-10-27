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
  it('D04 跟进：每个第三方品牌图标都登记了具体取图地址与日期（或标明是本站自制字母标识），登记表里不再有「待补」', () => {
    const manifest = JSON.parse(fs.readFileSync('src/data/icon-manifest.json', 'utf8')) as Record<
      string,
      { kind: string }
    >;
    const sources = JSON.parse(fs.readFileSync('src/data/icon-sources.json', 'utf8')) as Record<
      string,
      { url?: string; retrieved?: string; monogram?: boolean; note?: string }
    >;
    const tools = Object.keys(manifest).filter((k) => manifest[k].kind !== 'app');
    const bad = tools.filter((k) => {
      const s = sources[k];
      if (!s) return true;
      if (s.monogram) return !s.note;
      return !/^https:\/\/\S+$/.test(s.url ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.retrieved ?? '');
    });
    expect(bad).toEqual([]);
    // 登记里没有多余（已删除图标）的条目
    expect(Object.keys(sources).filter((k) => !tools.includes(k))).toEqual([]);
    const doc = fs.readFileSync('docs/ICON-LICENSES.md', 'utf8');
    expect(doc).not.toContain('待补');
    for (const k of tools) if (sources[k].url) expect(doc).toContain(sources[k].url!);
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
