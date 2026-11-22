/**
 * T9.1 设计 token：生成文件与 tokens/*.json 一致，数值与 DESIGN-SYSTEM §2–5、§21、§22.1 一致。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generate } from '../../scripts/design/build-tokens.mjs';
import { tokens, ALLOWED_WEIGHTS, TYPE_SIZES_PX } from '@/lib/tokens';

const root = resolve(__dirname, '../..');

const toRgb = (c: string): [number, number, number, number] => {
  if (c.startsWith('#')) {
    const h = c.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as [
      number,
      number,
      number,
      number,
    ];
  }
  const m = c.match(/rgba?\(([^)]+)\)/)!;
  const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim());
  return [+r, +g, +b, +a];
};
const blend = (fg: string, bg: string) => {
  const [r, g, b, a] = toRgb(fg);
  const [R, G, B] = toRgb(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
};
const lum = (c: number[]) => {
  const s = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const blendHex = (f: number[], b: number[], a: number) =>
  `#${[0, 1, 2]
    .map((i) =>
      Math.round(f[i] * a + b[i] * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const contrast = (fg: string, bg: string) => {
  const a = lum(blend(fg, bg));
  const b = lum(toRgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe('tokens 生成', () => {
  it('仓库里的生成文件是最新的（改 tokens/ 后要运行 npm run tokens）', async () => {
    const out: Record<string, string> = await generate();
    for (const [f, src] of Object.entries(out)) expect(readFileSync(resolve(root, f), 'utf8'), f).toBe(src);
  });

  it('字阶 9 档，数值与 DESIGN-SYSTEM §2 一致', () => {
    const s = tokens.scale;
    expect(Object.keys(s)).toEqual([
      'display',
      'title-1',
      'title-2',
      'title-3',
      'headline',
      'body',
      'body-sm',
      'meta',
      'caption',
    ]);
    expect([s.display.size, s.display.sizeBase]).toEqual([48, 34]);
    expect([s['title-1'].size, s['title-1'].sizeBase]).toEqual([32, 28]);
    expect([
      s['title-2'].size,
      s['title-3'].size,
      s.headline.size,
      s.body.size,
      s['body-sm'].size,
      s.meta.size,
      s.caption.size,
    ]).toEqual([22, 17, 15, 17, 15, 13, 12]);
    expect(s.body.lh).toBe(1.76);
    expect(Math.min(...TYPE_SIZES_PX)).toBeGreaterThanOrEqual(tokens.minFontSize);
  });

  it('字重只允许 400 / 600 / 700', () => {
    expect([...ALLOWED_WEIGHTS]).toEqual([400, 600, 700]);
  });

  it('字体栈按 §22.1：雅黑 UI 在雅黑前、不含网络字体', () => {
    expect(tokens.fontSans).toContain("'Segoe UI Variable Text'");
    expect(tokens.fontSans.indexOf("'Microsoft YaHei UI'")).toBeLessThan(
      tokens.fontSans.indexOf("'Microsoft YaHei'"),
    );
    expect(tokens.fontSans.trim().endsWith('sans-serif')).toBe(true);
  });

  it('间距 13 档、圆角 5 档、z-index 7 档、断点含 1600、动效 4 档', () => {
    expect(Object.values(tokens.space).sort((a, b) => a - b)).toEqual([
      0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80,
    ]);
    expect(tokens.radius).toEqual({ xs: 6, sm: 10, md: 14, lg: 20, pill: 999 });
    expect(Object.values(tokens.z)).toEqual([0, 10, 100, 200, 300, 400, 500]);
    expect(tokens.breakpoints).toEqual({ sm: 600, md: 900, lg: 1200, xl: 1600 });
    expect([
      tokens.duration.instant,
      tokens.duration.fast,
      tokens.duration.base,
      tokens.duration.slow,
    ]).toEqual(['80ms', '160ms', '240ms', '360ms']);
    expect([tokens.layout.container, tokens.layout['container-xl'], tokens.layout['reading-max']]).toEqual([
      1200, 1360, 680,
    ]);
  });

  it('文字色对比 ≥ 4.5:1，焦点色不透明且 ≥ 3:1（深浅两套）', () => {
    for (const mode of ['light', 'dark'] as const) {
      const c = tokens.color[mode] as Record<string, string>;
      for (const bg of [c.bg, c.surface, c['surface-2']]) {
        for (const fg of ['label', 'label-2', 'label-3'])
          expect(contrast(c[fg], bg), `${mode} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(c.focus.startsWith('#'), 'focus 必须不透明').toBe(true);
        expect(contrast(c.focus, bg), `${mode} focus on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(c['on-accent'], c.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('P10h 类型强调色 / 淡底按钮 / 实心按钮对比度 ≥ 4.5:1（深浅两套、悬停档）', () => {
    for (const mode of ['light', 'dark'] as const) {
      const c = tokens.color[mode] as Record<string, string>;
      const hover = parseFloat(c['tint-hover']) / 100;
      for (const ink of ['type-app', 'type-ai', 'type-game', 'accent-ink', 'danger-ink', 'success-ink']) {
        for (const bg of [c.bg, c.surface]) {
          // 淡底 = ink 按 tint-hover 比例混到页面底色上（静止档 tint-rest 更淡，对比更高）
          const [r, g, b] = toRgb(c[ink]);
          const softHex = blendHex([r, g, b], toRgb(bg), hover);
          expect(contrast(c[ink], softHex), `${mode} ${ink} on tint ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(c['on-solid'], c[ink]), `${mode} on-solid on ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('样式文件不再出现 650 / 750 / 800 字重与非档位字号', () => {
    const dir = resolve(root, 'src/styles');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.css') && x !== 'tokens.css')) {
      const css = readFileSync(resolve(dir, f), 'utf8');
      expect(css, f).not.toMatch(/font-weight:\s*(500|650|750|800)\b/);
      expect(css, f).not.toMatch(/font-size:\s*(10|11)px/);
      expect(css, f).not.toMatch(/font-size:\s*clamp\(/);
    }
  });
});
