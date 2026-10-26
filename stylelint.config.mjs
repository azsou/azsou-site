/**
 * Q1 token lint（DESIGN-QA §2.1）：字号 / 字重 / 颜色 / 圆角 / 阴影 / z-index / 时长 / 断点都必须走 token。
 * T9.21 起全部文件一律 error（存量 warning 清单 stylelint.legacy.json 已删除）。确需例外的个别声明用
 * `stylelint-disable-next-line <规则> -- <原因>` 就地说明（打印物理单位、媒体上的固定白字、第三方品牌色等），
 * 例外清单见 docs/DESIGN-AUDIT-3.md §D1。src/styles/tokens.css 是生成文件，不检查。
 */

const tokenRules = (severity) => {
  const o = { severity };
  return {
    'declaration-property-value-allowed-list': [
      {
        'font-size': ['/var\\(--fs-/', 'inherit', '100%'],
        'font-weight': ['/^var\\(--fw-/', 'inherit'],
        'line-height': ['/^var\\(--lh-/', 'inherit', '1', '0', 'normal'],
        'letter-spacing': ['/^var\\(--ls-/', '0', 'normal', 'inherit'],
        'z-index': ['/^var\\(--z-/', '0', '1', '-1', 'auto'],
        'border-radius': ['/^var\\(--(radius|icon)-/', '0', '50%', 'inherit'],
        'box-shadow': ['/var\\(--/', 'none'],
        // 0.01ms：减少动态的全局兜底（global.css @layer utilities）
        'transition-duration': ['/^var\\(--dur/', '0s', '0.01ms'],
        'animation-duration': ['/^var\\(--dur/', '0.01ms'],
      },
      o,
    ],
    'color-no-hex': [true, o],
    'function-disallowed-list': [['rgb', 'rgba', 'hsl', 'hsla'], o],
    'declaration-no-important': [true, o],
    'media-feature-name-value-allowed-list': [
      {
        'min-width': ['600px', '900px', '1200px', '1600px'],
        // 只允许断点的补集（min-width: 600px 的反面写成 max-width: 599.98px）
        'max-width': ['599.98px', '899.98px', '1199.98px', '1599.98px'],
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
  overrides: [{ files: ['**/*.astro'], customSyntax: 'postcss-html' }],
};
