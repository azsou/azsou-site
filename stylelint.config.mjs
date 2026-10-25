/**
 * Q1 token lint（DESIGN-QA §2.1）：字号 / 字重 / 颜色 / 圆角 / 阴影 / z-index / 时长 / 断点都必须走 token。
 * 过渡期：stylelint.legacy.json 里列出的存量文件按 warning 报告（T9.21 改为 error 并删掉清单）；
 * 其余文件（新增的组件、样式）一律 error。src/styles/tokens.css 是生成文件，不检查。
 */
import { readFileSync } from 'node:fs';

const legacy = JSON.parse(readFileSync(new URL('./stylelint.legacy.json', import.meta.url), 'utf8')).files;

const tokenRules = (severity) => {
  const o = { severity };
  return {
    'declaration-property-value-allowed-list': [
      {
        'font-size': ['/^var\\(--fs-/', 'inherit', '100%'],
        'font-weight': ['/^var\\(--fw-/', 'inherit'],
        'line-height': ['/^var\\(--lh-/', 'inherit', '1', '0', 'normal'],
        'letter-spacing': ['/^var\\(--ls-/', '0', 'normal', 'inherit'],
        'z-index': ['/^var\\(--z-/', '0', '1', '-1', 'auto'],
        'border-radius': ['/^var\\(--(radius|icon)-/', '0', '50%', 'inherit'],
        'box-shadow': ['/var\\(--/', 'none'],
        'transition-duration': ['/^var\\(--dur/', '0s'],
        'animation-duration': ['/^var\\(--dur/'],
      },
      o,
    ],
    'color-no-hex': [true, o],
    'function-disallowed-list': [['rgb', 'rgba', 'hsl', 'hsla'], o],
    'declaration-no-important': [true, o],
    'media-feature-name-value-allowed-list': [
      {
        'min-width': ['600px', '900px', '1200px', '1600px'],
        'max-width': [],
        'max-height': ['480px'],
      },
      o,
    ],
    'unit-allowed-list': [
      ['px', 'rem', 'em', '%', 'vh', 'dvh', 'svh', 'vw', 'fr', 'ms', 's', 'deg', 'ch', 'cqi'],
      o,
    ],
  };
};

export default {
  ignoreFiles: ['src/styles/tokens.css', 'dist/**', 'legacy/**', 'node_modules/**'],
  rules: tokenRules('error'),
  overrides: [
    { files: ['**/*.astro'], customSyntax: 'postcss-html' },
    { files: legacy, rules: tokenRules('warning') },
  ],
};
