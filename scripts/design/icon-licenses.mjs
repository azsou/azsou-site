/**
 * D04：品牌图标与 UI 图标的来源 / 许可登记（生成 docs/ICON-LICENSES.md）。
 *   node scripts/design/icon-licenses.mjs          重新生成
 *   node scripts/design/icon-licenses.mjs --check  内容不一致时退出码 1（单测也会核对条目齐全）
 * 品牌图标（第三方 AI 工具）只用于识别；来源列取各工具 frontmatter 的官网 / 开发者链接，具体取图页面未逐个记录的标「待补」。
 */
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(fs.readFileSync('src/data/icon-manifest.json', 'utf8'));
const front = (dir, slug) => {
  for (const ext of ['.md', '.mdx']) {
    const f = path.join('src/content', dir, slug + ext);
    if (!fs.existsSync(f)) continue;
    const m = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(f, 'utf8'));
    try {
      return JSON.parse(m?.[1] ?? '{}');
    } catch {
      return {};
    }
  }
  return {};
};
const rows = Object.entries(manifest)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([slug, v]) => {
    if (v.kind === 'app')
      return `| \`${slug}\` | 自研应用 | ${v.dir}/${slug} | AZ Studio 原创（本仓库 scripts/icons） | 保留所有权利 |`;
    const fm = front('tools', slug);
    const src = fm.website || fm.developer?.url || '待补';
    return `| \`${slug}\` | 第三方 AI 工具 | ${v.dir}/${slug} | ${src} | 商标归 ${fm.developer?.name ?? '各自所有者'} 所有，仅用于识别 |`;
  });
const doc = `# 图标与品牌资产登记（D04）

> 由 \`node scripts/design/icon-licenses.mjs\` 生成，勿手改；新增图标后重新生成。

## UI 图标

| 来源 | 版本 | 许可 | 位置 |
| --- | --- | --- | --- |
| Lucide（lucide-static） | 0.462.0 | ISC | \`src/lib/lucide.ts\`（子集，24 网格、描边 1.75、round 端点、currentColor） |
| GitHub 标志（填充字标） | — | GitHub 商标，按其 Logo 使用规范仅用于指向 GitHub 链接 | \`src/components/Icon.astro\` |

- 不使用 SF Symbols、不打包 Apple 字体或其它 Apple 专有资产；字体走系统字体栈。
- 搜索结果行的类型图标（\`src/scripts/search/render.ts\` 的 TYPE_ICON）与 \`src/lib/lucide.ts\` 逐字一致，由 \`tests/unit/icons.test.ts\` 校验。

## 应用与品牌图标（${rows.length} 个，来自 \`src/data/icon-manifest.json\`）

| 标识 | 类型 | 路径 | 来源 | 许可 / 使用条件 |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

来源为「待补」或只给出官网首页的条目，具体取图页面未逐个记录：**待站长确认**是否需要逐个补记取图链接与日期。
`;
const out = 'docs/ICON-LICENSES.md';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== doc) {
    console.error(`${out} 与生成结果不一致：运行 node scripts/design/icon-licenses.mjs`);
    process.exit(1);
  }
} else fs.writeFileSync(out, doc);
