/**
 * 素材 OG 图字体验证（R12-F；R12-G 收紧 800 例外并按槽位调用）。与 src/pages/og/art/[slot].png.ts 调用同一个 renderArtSvg。
 * 用法：node scripts/design/og-art-verify.mjs [--font-dir <dir>] [--out <png 目录>] [--report <json>]
 * - 检查 public/art 全部 SVG：每个有效文字运行的族、字重、字形覆盖；有文字的文件数须为 15。
 * - --out 时渲染全部 art.json 槽位（40 个）写 PNG。
 * - 绑定像素自检：每个文字运行单独放进一张探针 SVG（保留原 font-family / font-weight），经 renderArtSvg 渲染，
 *   与「只加载解析出的那一个字体文件」的参照渲染逐像素比较，不相同即 FAIL（防止 resvg 实际解析与声明的映射不一致）。
 *   800→700 批准例外的运行按原字号 13 放进放大视口的探针（带槽位），其它运行用 64 号字探针。
 * - 缺字体文件、缺字形、不支持的映射 → 退出码 1（FAIL），不会输出带豆腐块的图并报 PASS。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectArtSvg, loadArtFonts, renderArtSvg } from '../../src/lib/og-art-render.ts';

const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js');
const xml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (k, v) => (v === null || v === undefined ? '' : ` ${k}="${xml(v).replace(/"/g, '&quot;')}"`);

/** 绑定像素自检：正式渲染 vs 只加载预期字体的参照渲染（参照只用于比较，不产出 OG 图）。 */
function bindingCheck(run, set, slot) {
  const exception = run.weightUsed !== run.weightDeclared;
  const svg = exception
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 27"><text x="20" y="20"' +
      `${attr('font-size', run.fontSize)}${attr('font-family', run.fontFamily)}${attr('font-weight', run.fontWeight)} fill="#ffffff">${xml(run.text)}</text></svg>`
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="20" y="300" font-size="64"' +
      `${attr('font-family', run.fontFamily)}${attr('font-weight', run.fontWeight)} fill="#ffffff">${xml(run.text)}</text></svg>`;
  const official = renderArtSvg(svg, set, exception ? { slot } : {}).pixels;
  const fit = { fitTo: { mode: 'width', value: 1200 }, background: '#101014' };
  const f = set.fonts.find((x) => path.basename(x.file) === run.fontFile);
  const ref = new Resvg(svg, {
    ...fit,
    font: { loadSystemFonts: false, fontFiles: [f.file], defaultFontFamily: f.family },
  }).render().pixels;
  return official.equals(Buffer.from(ref));
}

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const root = process.cwd();
const report = {
  fontDir: null,
  fonts: [],
  files: [],
  textFiles: 0,
  runs: 0,
  adjustments: 0,
  rendered: [],
  problems: [],
};
let fonts;
try {
  fonts = loadArtFonts(opt('--font-dir') ?? path.join(root, 'assets', 'og-fonts'));
  report.fontDir = fonts.dir;
  report.fonts = fonts.fonts.map((f) => ({
    file: path.basename(f.file),
    family: f.family,
    weight: f.weight,
    cmap: f.cmap.size,
  }));
  report.binding = {
    defaultFontFamily: fonts.sansFamily,
    sansSerifFamily: fonts.sansFamily,
    monospaceFamily: fonts.monoFamily,
  };
} catch (e) {
  report.problems.push(String(e.message ?? e));
}
if (fonts) {
  const dir = path.join(root, 'public', 'art');
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.svg'))
    .sort()) {
    const slot = f.replace(/\.svg$/, '');
    const a = inspectArtSvg(fs.readFileSync(path.join(dir, f), 'utf8'), fonts, { slot });
    if (a.runs.length) report.textFiles++;
    report.runs += a.runs.length;
    report.adjustments += a.adjustments.length;
    report.files.push({ file: f, runs: a.runs, adjustments: a.adjustments, problems: a.problems });
    for (const p of a.problems) report.problems.push(`${f}: ${p}`);
    if (!a.problems.length)
      for (const r of a.runs) {
        r.bindingPixelMatch = bindingCheck(r, fonts, slot);
        report.bindingChecks = (report.bindingChecks ?? 0) + 1;
        if (!r.bindingPixelMatch)
          report.problems.push(`${f}: run#${r.index} "${r.text}" 实际渲染与 ${r.fontFile} 参照不一致`);
      }
  }
  if (report.textFiles !== 15) report.problems.push(`有文字的 SVG 数量 ${report.textFiles} ≠ 15`);
  const out = opt('--out');
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const slots = Object.keys(
      JSON.parse(fs.readFileSync(path.join(root, 'src', 'data', 'art.json'), 'utf8')),
    );
    for (const slot of slots) {
      try {
        const { png } = renderArtSvg(fs.readFileSync(path.join(dir, `${slot}.svg`), 'utf8'), fonts, { slot });
        fs.writeFileSync(path.join(out, `${slot}.png`), png);
        report.rendered.push(slot);
      } catch (e) {
        report.problems.push(`render ${slot}: ${e.message ?? e}`);
      }
    }
    if (report.rendered.length !== 40) report.problems.push(`渲染槽位 ${report.rendered.length} ≠ 40`);
  }
}
report.result = report.problems.length ? 'FAIL' : 'PASS';
if (opt('--report')) fs.writeFileSync(opt('--report'), JSON.stringify(report, null, 1) + '\n');
console.log(
  `fonts=${report.fonts.length} svg=${report.files.length} textFiles=${report.textFiles} runs=${report.runs} bindingChecks=${report.bindingChecks ?? 0} adjustments=${report.adjustments} rendered=${report.rendered.length} problems=${report.problems.length} result=${report.result}`,
);
for (const p of report.problems) console.log('PROBLEM', p);
process.exit(report.problems.length ? 1 : 0);
