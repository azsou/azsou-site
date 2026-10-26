/** 仪表盘柱状图的几何计算（纯函数，渲染在 scripts/admin/dashboard.ts 里用 SVG DOM 完成，不引图表库）。 */
export interface BarSeries {
  key: string;
  values: number[];
}
export interface BarRect {
  series: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

/** 「好看」的坐标上限：1 / 2 / 5 × 10^n */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

/** 分组柱状图：每个时间点一组，组内各系列并排 */
export function groupedBars(
  series: BarSeries[],
  opts: { width: number; height: number; gap?: number; pad?: number },
): { bars: BarRect[]; max: number; groupWidth: number } {
  const count = Math.max(0, ...series.map((s) => s.values.length));
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const pad = opts.pad ?? 0;
  const groupWidth = count ? (opts.width - pad * 2) / count : 0;
  const gap = Math.min(opts.gap ?? 2, groupWidth / 4);
  const barWidth = series.length ? Math.max(1, (groupWidth - gap) / series.length) : 0;
  const bars: BarRect[] = [];
  for (let i = 0; i < count; i++)
    series.forEach((s, j) => {
      const v = Math.max(0, s.values[i] ?? 0);
      const height = (v / max) * opts.height;
      bars.push({
        series: s.key,
        index: i,
        x: pad + i * groupWidth + gap / 2 + j * barWidth,
        y: opts.height - height,
        width: barWidth,
        height,
        value: v,
      });
    });
  return { bars, max, groupWidth };
}
