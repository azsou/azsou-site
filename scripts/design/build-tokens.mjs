#!/usr/bin/env node
/**
 * 设计 token 单一来源（T9.1）：tokens/*.json → 生成
 *   - src/styles/tokens.css   全站 CSS 变量（@layer tokens）+ 字阶组合类 .t-*（@layer utilities）+ 旧变量别名
 *   - src/lib/tokens.ts       TS 常量（断点、字阶等给脚本 / 测试 / OG 生成用）
 *   - public/cms/preview.css  Decap 预览样式的 token 部分（T9.17 在此基础上加卡片样式）
 * 用法：node scripts/design/build-tokens.mjs           写文件
 *       node scripts/design/build-tokens.mjs --check   只比较，生成结果与仓库不一致时退出 1（CI / 单测）
 * 没用 Style Dictionary：三份输出都很小，自写生成器零依赖、输出可控（DESIGN-SYSTEM 允许「或等价物」）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => JSON.parse(readFileSync(resolve(ROOT, 'tokens', f), 'utf8'));

export function loadTokens() {
  return { type: read('typography.json'), color: read('color.json'), base: read('base.json') };
}

const rem = (px) => (px === 0 ? '0' : `${+(px / 16).toFixed(4)}rem`);
const px = (n) => (n === 0 ? '0' : `${n}px`);

/** 旧变量 → 新 token（过渡期别名；T9.21 门禁收紧时删除） */
const LEGACY = {
  '--text-xs': 'var(--fs-caption)',
  '--text-sm': 'var(--fs-meta)',
  '--text-ui': 'var(--fs-body-sm)',
  '--text-body': 'var(--fs-body)',
  '--text-title': 'var(--fs-title-2)',
  '--text-large': 'var(--fs-title-1)',
  '--text-display': 'var(--fs-display)',
  '--c-bg-elevated': 'var(--c-surface)',
  '--c-bg-grouped': 'var(--c-surface)',
  '--c-accent-contrast': 'var(--c-on-accent)',
  '--c-blue': 'var(--c-hue-blue)',
  '--c-green': 'var(--c-hue-green)',
  '--c-teal': 'var(--c-hue-teal)',
  '--c-orange': 'var(--c-hue-orange)',
  '--c-purple': 'var(--c-hue-purple)',
  '--shadow-1': 'var(--elev-1)',
  '--shadow-2': 'var(--elev-2)',
  '--shadow-3': 'var(--elev-2)',
  '--focus-ring': '0 0 0 2px var(--c-focus)',
  '--radius-xl': 'var(--radius-lg)',
  '--content-max': 'var(--container)',
};

function colorVars(set) {
  return Object.entries(set)
    .map(([k, v]) =>
      k.startsWith('elev-')
        ? `--${k}: ${v};`
        : k === 'icon-stroke'
          ? `--icon-stroke: ${v};`
          : k.startsWith('cover-')
            ? `--${k}: ${v};`
            : `--c-${k}: ${v};`,
    )
    .join('\n');
}

export function buildCss({ type, color, base }) {
  const L = [];
  L.push(
    '/* 由 scripts/design/build-tokens.mjs 从 tokens/*.json 生成 —— 不要手改；改 tokens/ 后运行 npm run tokens */',
  );
  L.push('@layer reset, tokens, base, components, utilities;');
  L.push('@layer tokens {');
  L.push(':root {');
  L.push('color-scheme: light dark;');
  L.push(`--font-sans: ${type.font.sans};`, `--font-mono: ${type.font.mono};`);
  for (const [k, v] of Object.entries(type.weight)) L.push(`--fw-${k}: ${v};`);
  for (const [k, s] of Object.entries(type.scale)) {
    L.push(
      `--fs-${k}: ${rem(s.sizeBase ?? s.size)};`,
      `--lh-${k}: ${s.lh};`,
      `--fw-${k}: var(--fw-${s.weight});`,
      `--ls-${k}: ${s.tracking};`,
    );
  }
  for (const [k, v] of Object.entries(base.space)) L.push(`--space-${k}: ${px(v)};`);
  for (const [k, v] of Object.entries(base.control)) L.push(`--control-${k}: ${px(v)};`);
  for (const [k, v] of Object.entries(base.radius)) L.push(`--radius-${k}: ${px(v)};`);
  L.push(
    `--dur-instant: ${base.duration.instant};`,
    `--dur-fast: ${base.duration.fast};`,
    `--dur: ${base.duration.base};`,
    `--dur-slow: ${base.duration.slow};`,
    `--dur-shimmer: ${base.duration.shimmer};`,
  );
  for (const [k, v] of Object.entries(base.easing)) L.push(`--ease-${k}: ${v};`);
  for (const [k, v] of Object.entries(base.z)) L.push(`--z-${k}: ${v};`);
  const lay = base.layout;
  L.push(
    `--container: ${px(lay.container)};`,
    `--reading-max: ${rem(lay['reading-max'])};`,
    `--gutter: ${px(lay['gutter-base'])};`,
  );
  L.push(
    `--nav-h: ${px(lay['nav-h'])};`,
    `--tabbar-h: ${px(lay['tabbar-h'])};`,
    `--touch: ${px(lay.touch)};`,
  );
  for (const [k, v] of Object.entries(base.icon))
    L.push(`--icon-${k}: ${typeof v === 'number' ? px(v) : v};`);
  // P10 T10.3 紧凑档：--density-section-gap / --density-card-pad / --density-entry-icon-*
  for (const [k, v] of Object.entries(base.density ?? {})) L.push(`--density-${k}: ${px(v)};`);
  L.push(
    '--safe-top: env(safe-area-inset-top, 0px);',
    '--safe-right: env(safe-area-inset-right, 0px);',
    '--safe-bottom: env(safe-area-inset-bottom, 0px);',
    '--safe-left: env(safe-area-inset-left, 0px);',
  );
  L.push(colorVars(color.light));
  L.push('/* 旧变量别名（过渡期，新代码不要用） */');
  for (const [k, v] of Object.entries(LEGACY)) L.push(`${k}: ${v};`);
  L.push('}');
  // 响应式字阶与布局（断点只用 600 / 900 / 1200 / 1600）
  const bp = base.breakpoint;
  const scaled = Object.entries(type.scale).filter(([, s]) => s.sizeBase);
  L.push(
    `@media (min-width: ${bp.sm}px) { :root { --gutter: ${px(lay['gutter-sm'])}; ${scaled
      .filter(([k]) => k !== 'display')
      .map(([k, s]) => `--fs-${k}: ${rem(s.size)};`)
      .join(' ')} } }`,
  );
  L.push(
    `@media (min-width: ${bp.md}px) { :root { --gutter: ${px(lay['gutter-md'])}; --fs-display: ${rem(type.scale.display.size)}; } }`,
  );
  L.push(`@media (min-width: ${bp.xl}px) { :root { --container: ${px(lay['container-xl'])}; } }`);
  // 英文行高
  L.push(
    `:root:lang(en) { ${Object.entries(type.scale)
      .map(([k, s]) => `--lh-${k}: ${s.lhEn};`)
      .join(' ')} }`,
  );
  L.push(
    `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ${colorVars(color.dark)} } }`,
  );
  L.push(`:root[data-theme='dark'] { color-scheme: dark; ${colorVars(color.dark)} }`);
  L.push(`:root[data-theme='light'] { color-scheme: light; }`);
  L.push('}');
  // 字阶组合类：字号 / 行高 / 字重 / 字距绑定，禁止单独改其中一项
  L.push('@layer utilities {');
  for (const k of Object.keys(type.scale)) {
    L.push(
      `.t-${k} { font-size: var(--fs-${k}); line-height: var(--lh-${k}); font-weight: var(--fw-${k}); letter-spacing: var(--ls-${k}); }`,
    );
  }
  L.push('}');
  return L.join('\n');
}

export function buildTs({ type, color, base }) {
  const data = {
    fontSans: type.font.sans,
    fontMono: type.font.mono,
    weights: type.weight,
    scale: type.scale,
    minFontSize: type.minSize,
    color,
    space: base.space,
    control: base.control,
    radius: base.radius,
    duration: base.duration,
    easing: base.easing,
    z: base.z,
    breakpoints: base.breakpoint,
    layout: base.layout,
    icon: base.icon,
    density: base.density,
  };
  return `// 由 scripts/design/build-tokens.mjs 从 tokens/*.json 生成 —— 不要手改\nexport const tokens = ${JSON.stringify(data, null, 2)} as const;\nexport type Tokens = typeof tokens;\nexport const ALLOWED_WEIGHTS = [${Object.values(type.weight).join(', ')}] as const;\nexport const TYPE_SIZES_PX = [${[...new Set(Object.values(type.scale).flatMap((s) => [s.size, s.sizeBase].filter(Boolean)))].sort((a, b) => a - b).join(', ')}] as const;\n`;
}

export function buildPreview({ type, color, base }) {
  return `/* Decap CMS 预览样式（token 部分）—— 由 scripts/design/build-tokens.mjs 生成，不要手改 */\n:root { --font-sans: ${type.font.sans}; ${colorVars(color.light)} ${Object.entries(
    base.radius,
  )
    .map(([k, v]) => `--radius-${k}: ${px(v)};`)
    .join(' ')} ${Object.entries(base.space)
    .map(([k, v]) => `--space-${k}: ${px(v)};`)
    .join(
      ' ',
    )} }\nbody { margin: 0; padding: var(--space-6); font-family: var(--font-sans); font-size: ${rem(type.scale.body.size)}; line-height: ${type.scale.body.lh}; color: var(--c-label); background: var(--c-bg); }\n`;
}

export async function generate() {
  const t = loadTokens();
  const cfg = (await prettier.resolveConfig(resolve(ROOT, 'package.json'))) ?? {};
  const fmt = (src, parser) => prettier.format(src, { ...cfg, parser });
  return {
    'src/styles/tokens.css': await fmt(buildCss(t), 'css'),
    'src/lib/tokens.ts': await fmt(buildTs(t), 'typescript'),
    'public/cms/preview.css': await fmt(buildPreview(t), 'css'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await generate();
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [f, src] of Object.entries(out)) {
    const p = resolve(ROOT, f);
    let cur = '';
    try {
      cur = readFileSync(p, 'utf8');
    } catch {
      /* 新文件 */
    }
    if (cur === src) continue;
    if (check) {
      console.error(`过期：${f}（运行 npm run tokens）`);
      stale++;
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, src);
      console.log(`写入 ${f}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
