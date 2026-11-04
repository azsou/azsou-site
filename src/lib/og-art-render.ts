/**
 * 素材 OG 图（public/art/*.svg → 1200×675 PNG）的唯一渲染函数（R12-F）。
 * 只给 src/pages/og/art/[slot].png.ts 与 scripts/design/og-art-verify.mjs 共用。
 *
 * - 不加载系统字体；只加载 assets/og-fonts 里的四个受控子集（OFL 1.1，见 assets/og-fonts/SOURCE.md）。
 * - 家族名从字体文件 name 表读取（typographic family 16，缺省回落 family 1，与 fontdb 一致），不按文件名绑定。
 * - 每个文字运行先解析出族与字重，必须精确命中一个已加载字体且字形全覆盖，否则抛错（不渲染豆腐块）。
 * - 设计调整（R12-G 收紧）：800→700 只允许用于 work-3、work-7、work-15 里那 3 个 13px 的「!」
 *   （ART_WEIGHT_EXCEPTIONS）；其它任何 800（别的文字、别的字号、别的槽位、未给槽位）一律报错，不静默归一。
 * - 实测 @resvg/resvg-js 2.6.2 的 sansSerifFamily / monospaceFamily 不生效（通用族一律落到 defaultFontFamily，
 *   见 R12-F round1 诊断），所以渲染输入里的 font-family 列表在内存中改写为解析出的内部家族名；
 *   三个选项仍按要求设置。public/art 原文件不改。
 * - R12-G：解析与改写共用同一个词法扫描（lexArtSvg），改写只发生在实际解析出的属性值位置
 *   （单引号、双引号、"=" 两侧空白按真实语法处理）；改写后再扫描复核，不一致即报错。
 *   无法解析的输入（如不带引号的属性值、重复属性）在渲染前报错，不回退。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

export const ART_WIDTH = 1200;
export const ART_BACKGROUND = '#101014';
export const ART_FONT_FILES = [
  'NotoSansSC-Regular.subset.otf',
  'NotoSansSC-Bold.subset.otf',
  'NotoSansSC-Black.subset.otf',
  'NotoSansMonoCJKsc-Regular.subset.otf',
] as const;
/** 设计调整：声明字重 → 实际渲染字重（只作用于内存渲染输入，且只在 ART_WEIGHT_EXCEPTIONS 范围内） */
export const ART_WEIGHT_NORMALIZE: Readonly<Record<number, number>> = { 800: 700 };
/** 800→700 的唯一批准范围：这三个槽位里自身声明 font-weight 800、有效字号 13、无子元素、内容恰为「!」的 <text> */
export const ART_WEIGHT_EXCEPTIONS = {
  weight: 800,
  slots: ['work-3', 'work-7', 'work-15'],
  tag: 'text',
  text: '!',
  fontSize: 13,
} as const;

export type ArtFont = { file: string; family: string; weight: number; cmap: Set<number> };
export type ArtFontSet = { dir: string; fonts: ArtFont[]; sansFamily: string; monoFamily: string };
export type ArtRun = {
  index: number;
  tag: string;
  text: string;
  fontFamily: string | null;
  fontWeight: string | null;
  fontSize?: string | null;
  family?: string;
  via?: string;
  weightDeclared?: number;
  weightUsed?: number;
  fontFile?: string;
  missing?: string[];
  error?: string;
};
export type ArtAnalysis = { runs: ArtRun[]; problems: string[]; adjustments: string[]; svg: string };
export type ArtRenderOptions = { slot?: string };

// ---------- 最小 sfnt 解析：name / OS/2 / cmap(4, 12) ----------

function tables(buf: Buffer): Map<string, { off: number; len: number }> {
  const n = buf.readUInt16BE(4);
  const out = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    out.set(buf.toString('latin1', r, r + 4), {
      off: buf.readUInt32BE(r + 8),
      len: buf.readUInt32BE(r + 12),
    });
  }
  return out;
}

function nameOf(buf: Buffer, t: { off: number }, id: number): string | null {
  const count = buf.readUInt16BE(t.off + 2);
  const strOff = t.off + buf.readUInt16BE(t.off + 4);
  for (let i = 0; i < count; i++) {
    const r = t.off + 6 + i * 12;
    const [plat, enc, lang, nid, len, off] = [0, 2, 4, 6, 8, 10].map((d) => buf.readUInt16BE(r + d));
    if (nid === id && plat === 3 && enc === 1 && lang === 0x409) {
      return buf
        .subarray(strOff + off, strOff + off + len)
        .swap16()
        .toString('utf16le');
    }
  }
  return null;
}

function cmapOf(buf: Buffer, t: { off: number }): Set<number> {
  const set = new Set<number>();
  const n = buf.readUInt16BE(t.off + 2);
  for (let i = 0; i < n; i++) {
    const r = t.off + 4 + i * 8;
    const plat = buf.readUInt16BE(r);
    const enc = buf.readUInt16BE(r + 2);
    const sub = t.off + buf.readUInt32BE(r + 4);
    const fmt = buf.readUInt16BE(sub);
    if (plat !== 3 || (enc !== 1 && enc !== 10)) continue;
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = buf.readUInt16BE(ends + s);
        const start = buf.readUInt16BE(starts + s);
        const delta = buf.readInt16BE(deltas + s);
        const ro = buf.readUInt16BE(ranges + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            g = buf.readUInt16BE(ranges + s + ro + (c - start) * 2);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) set.add(c);
        }
      }
    } else if (fmt === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const r2 = sub + 16 + g * 12;
        const start = buf.readUInt32BE(r2);
        const end = buf.readUInt32BE(r2 + 4);
        const gid = buf.readUInt32BE(r2 + 8);
        for (let c = start; c <= end; c++) if (gid + (c - start) !== 0) set.add(c);
      }
    }
  }
  return set;
}

export function readFontInfo(file: string): ArtFont {
  const buf = fs.readFileSync(file);
  const t = tables(buf);
  const name = t.get('name');
  const os2 = t.get('OS/2');
  const cmap = t.get('cmap');
  if (!name || !os2 || !cmap) throw new Error(`OG art font ${file}: 缺少 name / OS/2 / cmap 表`);
  const family = nameOf(buf, name, 16) ?? nameOf(buf, name, 1);
  if (!family) throw new Error(`OG art font ${file}: name 表没有 family`);
  return { file, family, weight: buf.readUInt16BE(os2.off + 4), cmap: cmapOf(buf, cmap) };
}

/** 加载受控字体并按内部名确定 sans / mono 家族；缺文件、家族不一致、字重不对一律抛错。 */
export function loadArtFonts(dir = path.join(process.cwd(), 'assets', 'og-fonts')): ArtFontSet {
  const fonts = ART_FONT_FILES.map((f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error(`OG art font missing: ${p}`);
    return readFontInfo(p);
  });
  const [reg, bold, black, mono] = fonts;
  if (reg.family !== bold.family || reg.family !== black.family)
    throw new Error(`OG art sans 家族不一致: ${reg.family} / ${bold.family} / ${black.family}`);
  if (mono.family === reg.family) throw new Error('OG art mono 家族与 sans 相同');
  const expect = [400, 700, 900, 400];
  fonts.forEach((f, i) => {
    if (f.weight !== expect[i])
      throw new Error(`OG art font ${f.file}: usWeightClass ${f.weight} ≠ ${expect[i]}`);
  });
  return { dir, fonts, sansFamily: reg.family, monoFamily: mono.family };
}

// ---------- SVG 词法扫描（只认属性；<style>、style 里的字体声明等一律报为未解析） ----------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENT[e] ?? m),
  );
const FONT_PROPS = ['font-family', 'font-weight', 'font-style', 'font-size'] as const;
const SUSPECT = /^(font|font-variant|font-stretch|font-size-adjust|class)$/;
const TEXT_TAGS = new Set(['text', 'tspan']);
const BAD_TAGS = new Set([
  'style',
  'textPath',
  'tref',
  'altGlyph',
  'foreignObject',
  'font',
  'font-face',
  'glyph',
]);
const GENERIC_BAD = new Set(['serif', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji', 'fangsong']);
const SAFE_FAMILY = /^[A-Za-z0-9 ._-]+$/;

/** 实际解析出的属性：value 为解码并去首尾空白后的值；[start, end) 为原文中引号内原始值的位置 */
export type ArtAttr = { name: string; raw: string; value: string; start: number; end: number };
export type ArtElement = {
  index: number;
  tag: string;
  attrs: ArtAttr[];
  props: Record<string, string>;
  childElements: number;
};
export type ArtLexRun = { text: string; element: number };
export type ArtLex = { elements: ArtElement[]; runs: ArtLexRun[]; problems: string[] };

/**
 * 词法扫描整个 SVG（不预先删除注释，属性位置就是原文位置），供解析与改写共用。
 * 属性语法：name\s*=\s*("…"|'…')；不带引号的值、重复属性等都报为问题。
 */
export function lexArtSvg(svg: string): ArtLex {
  const problems: string[] = [];
  const elements: ArtElement[] = [];
  const runs: ArtLexRun[] = [];
  if (/<!ENTITY|<\?xml-stylesheet|<!\[CDATA\[/.test(svg))
    problems.push('含 DTD 实体 / 外部样式表 / CDATA，未解析');
  type Frame = { tag: string; props: Record<string, string>; element: number };
  const stack: Frame[] = [{ tag: '#root', props: {}, element: -1 }];
  const re =
    /(<!--[\s\S]*?-->)|(<\?[\s\S]*?\?>)|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const attrRe = /([\w:.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(svg))) {
    if (m.index !== consumed)
      problems.push(`无法解析的片段 @${consumed}: ${svg.slice(consumed, m.index).slice(0, 40)}`);
    consumed = re.lastIndex;
    if (m[1] !== undefined || m[2] !== undefined) continue;
    const top = stack[stack.length - 1];
    if (m[7] !== undefined) {
      const text = decode(m[7]).trim();
      if (!text) continue;
      if (!TEXT_TAGS.has(top.tag)) {
        if (top.tag !== 'title' && top.tag !== 'desc')
          problems.push(`<${top.tag}> 里有字符数据: ${text.slice(0, 20)}`);
        continue;
      }
      runs.push({ text, element: top.element });
      continue;
    }
    const [, , , close, tag, attrs, selfClose] = m;
    if (close) {
      if (stack.length < 2 || top.tag !== tag) problems.push(`标签不配对 </${tag}>`);
      else stack.pop();
      continue;
    }
    if (BAD_TAGS.has(tag)) problems.push(`未支持 / 未解析的元素 <${tag}>`);
    const attrsOff = m.index + 1 + tag.length;
    const el: ArtElement = {
      index: elements.length,
      tag,
      attrs: [],
      props: { ...top.props },
      childElements: 0,
    };
    const seen = new Set<string>();
    for (const a of attrs.matchAll(attrRe)) {
      const name = a[1];
      const raw = a[3] ?? a[4];
      const start = attrsOff + (a.index ?? 0) + name.length + a[2].length + 1;
      const q = svg[start - 1];
      if (
        svg.slice(start, start + raw.length) !== raw ||
        (q !== '"' && q !== "'") ||
        svg[start + raw.length] !== q
      )
        problems.push(`<${tag}> 属性 ${name} 位置解析不一致`);
      if (seen.has(name)) problems.push(`<${tag}> 重复属性 ${name}`);
      seen.add(name);
      const value = decode(raw).trim();
      el.attrs.push({ name, raw, value, start, end: start + raw.length });
      if ((FONT_PROPS as readonly string[]).includes(name)) el.props[name] = value;
      else if (SUSPECT.test(name)) problems.push(`<${tag}> 未解析的属性 ${name}="${value}"`);
      else if (name === 'style' && /(^|;)\s*(font|white-space|direction|writing-mode)/.test(value))
        problems.push(`<${tag}> style 里的字体声明未解析: ${value}`);
    }
    if (top.element >= 0) elements[top.element].childElements++;
    elements.push(el);
    if (!selfClose) stack.push({ tag, props: el.props, element: el.index });
  }
  if (consumed !== svg.length) problems.push('SVG 末尾有未解析内容');
  if (stack.length !== 1) problems.push('SVG 标签未闭合');
  return { elements, runs, problems };
}

/** font-family 列表 → 已加载的内部家族名：sans-serif / monospace 映射到绑定家族，未加载的具名族跳过。 */
function resolveFamily(
  famAttr: string | undefined,
  set: ArtFontSet,
): { family?: string; via?: string; error?: string } {
  if (famAttr === undefined) return { family: set.sansFamily, via: 'defaultFontFamily' };
  const loaded = new Map(set.fonts.map((f) => [f.family.toLowerCase(), f.family]));
  for (const raw of famAttr.split(',')) {
    const item = raw.trim().replace(/^["']|["']$/g, '');
    const low = item.toLowerCase();
    if (low === 'sans-serif') return { family: set.sansFamily, via: 'generic sans-serif' };
    if (low === 'monospace') return { family: set.monoFamily, via: 'generic monospace' };
    if (GENERIC_BAD.has(low)) return { error: `不支持的通用族 ${item}` };
    const hit = loaded.get(low);
    if (hit) return { family: hit, via: `named ${hit}` };
  }
  return { error: `font-family "${famAttr}" 无可解析项（不允许回退）` };
}

function parseWeight(v: string | null): number | null {
  if (v === null || v === 'normal') return 400;
  if (v === 'bold') return 700;
  return /^[1-9]00$/.test(v) ? Number(v) : null;
}

function parseSize(v: string | undefined): number | null {
  const mm = v === undefined ? null : /^(\d+(?:\.\d+)?)(px)?$/.exec(v);
  return mm ? Number(mm[1]) : null;
}

/** 声明的 800 是否落在批准例外内；返回 null 表示批准，否则返回拒绝原因。 */
function weightException(el: ArtElement, lex: ArtLex, slot: string | undefined): string | null {
  const E = ART_WEIGHT_EXCEPTIONS;
  const why: string[] = [];
  if (!slot || !(E.slots as readonly string[]).includes(slot))
    why.push(`槽位 ${slot ?? '(未给)'} 不在 ${E.slots.join('/')}`);
  if (el.tag !== E.tag) why.push(`元素 <${el.tag}> 不是 <${E.tag}>`);
  if (el.attrs.find((a) => a.name === 'font-weight')?.value !== String(E.weight))
    why.push(`${E.weight} 不是该元素自身声明`);
  if (parseSize(el.props['font-size']) !== E.fontSize)
    why.push(`有效字号 ${el.props['font-size'] ?? '(无)'} ≠ ${E.fontSize}`);
  const texts = lex.runs.filter((r) => r.element === el.index).map((r) => r.text);
  if (el.childElements !== 0 || texts.length !== 1 || texts[0] !== E.text)
    why.push(`内容不是唯一的「${E.text}」（文字 ${JSON.stringify(texts)}，子元素 ${el.childElements}）`);
  return why.length ? why.join('；') : null;
}

type Edit = { start: number; end: number; text: string; note: string };

/**
 * 解析 + 规划改写（同一次词法扫描）：每个文字运行求族、字重；font-family 属性在其解析位置改写为内部家族名；
 * 批准例外内的 font-weight 800 改为 700，其它 800 报错。返回改写后的 SVG（仅在无问题时有意义）。
 */
function planArtSvg(source: string, set: ArtFontSet, slot: string | undefined) {
  const lex = lexArtSvg(source);
  const problems = [...lex.problems];
  const adjustments: string[] = [];
  const edits: Edit[] = [];
  const approved = new Set<number>();
  for (const el of lex.elements) {
    for (const a of el.attrs) {
      if (a.name === 'font-family') {
        const r = resolveFamily(a.value, set);
        if (r.error || !r.family) problems.push(`<${el.tag}> ${r.error ?? 'font-family 无法解析'}`);
        else if (!SAFE_FAMILY.test(r.family)) problems.push(`内部家族名含不支持的字符: ${r.family}`);
        else if (r.family !== a.raw)
          edits.push({
            start: a.start,
            end: a.end,
            text: r.family,
            note: `font-family "${a.raw}"→"${r.family}"`,
          });
      } else if (a.name === 'font-weight' && parseWeight(a.value) === ART_WEIGHT_EXCEPTIONS.weight) {
        const why = weightException(el, lex, slot);
        const to = ART_WEIGHT_NORMALIZE[ART_WEIGHT_EXCEPTIONS.weight];
        if (why) problems.push(`<${el.tag}> font-weight ${a.value} 不在批准例外内（拒绝，不归一）：${why}`);
        else {
          approved.add(el.index);
          edits.push({
            start: a.start,
            end: a.end,
            text: String(to),
            note: `font-weight ${a.value}→${to}（批准例外）`,
          });
        }
      }
    }
  }
  const runs: ArtRun[] = lex.runs.map((lr, index) => {
    const el = lex.elements[lr.element];
    const p = el.props;
    const run: ArtRun = {
      index,
      tag: el.tag,
      text: lr.text,
      fontFamily: p['font-family'] ?? null,
      fontWeight: p['font-weight'] ?? null,
      fontSize: p['font-size'] ?? null,
    };
    const fam = resolveFamily(p['font-family'], set);
    if (fam.error || !fam.family) return { ...run, error: fam.error };
    const style = p['font-style'] ?? 'normal';
    if (style !== 'normal') return { ...run, error: `不支持的 font-style ${style}` };
    const declared = parseWeight(p['font-weight'] ?? null);
    if (declared === null) return { ...run, error: `无法解析的 font-weight ${p['font-weight']}` };
    let used = declared;
    let via = fam.via ?? '';
    if (p['font-family'] !== undefined && fam.family !== p['font-family'])
      via = `${via}; 渲染输入改写为 named ${fam.family}`;
    if (declared === ART_WEIGHT_EXCEPTIONS.weight) {
      if (!approved.has(lr.element))
        return { ...run, family: fam.family, error: `font-weight ${declared} 不在批准例外内（拒绝）` };
      used = ART_WEIGHT_NORMALIZE[declared];
      via = `${via}; 设计调整 ${declared}→${used}（批准例外）`;
    }
    const hits = set.fonts.filter((f) => f.family === fam.family && f.weight === used);
    if (hits.length !== 1)
      return { ...run, error: `${fam.family} 没有精确字重 ${used}（不允许就近字重回退）` };
    return {
      ...run,
      family: fam.family,
      via,
      weightDeclared: declared,
      weightUsed: used,
      fontFile: path.basename(hits[0].file),
    };
  });
  for (const r of runs) if (r.error) problems.push(`run#${r.index} "${r.text}": ${r.error}`);
  let svg = source;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    svg = svg.slice(0, e.start) + e.text + svg.slice(e.end);
  }
  for (const e of [...edits].sort((x, y) => x.start - y.start)) adjustments.push(e.note);
  return { svg, runs, problems, adjustments };
}

/** 改写后复核：再扫描一遍，文字运行一致、无残留 800、每个 font-family 已是内部家族名且绑定同一字体文件。 */
function recheckRewritten(svg: string, runs: ArtRun[], set: ArtFontSet): string[] {
  const out: string[] = [];
  const lex = lexArtSvg(svg);
  out.push(...lex.problems.map((p) => `改写后复核: ${p}`));
  const families = new Set(set.fonts.map((f) => f.family));
  for (const el of lex.elements)
    for (const a of el.attrs) {
      if (a.name === 'font-family' && !families.has(a.raw))
        out.push(`改写后复核: <${el.tag}> font-family "${a.raw}" 不是内部家族名`);
      if (a.name === 'font-weight' && parseWeight(a.value) === ART_WEIGHT_EXCEPTIONS.weight)
        out.push(`改写后复核: <${el.tag}> 仍有 font-weight ${a.value}`);
    }
  if (lex.runs.length !== runs.length) out.push('改写后复核: 文字运行数量不一致');
  lex.runs.forEach((lr, i) => {
    const r = runs[i];
    const p = lex.elements[lr.element].props;
    const fam = p['font-family'] ?? set.sansFamily;
    const w = parseWeight(p['font-weight'] ?? null);
    const hit = set.fonts.find((f) => f.family === fam && f.weight === w);
    if (!r || lr.text !== r.text || !hit || path.basename(hit.file) !== r.fontFile)
      out.push(`改写后复核: run#${i} "${lr.text}" 与解析结果不一致`);
  });
  return out;
}

function attachMissing(a: { runs: ArtRun[]; problems: string[] }, set: ArtFontSet) {
  for (const r of a.runs) {
    if (!r.fontFile) continue;
    const f = set.fonts.find((x) => path.basename(x.file) === r.fontFile);
    r.missing = [...r.text].filter((c) => !f?.cmap.has(c.codePointAt(0) ?? 0));
    if (r.missing.length)
      a.problems.push(`run#${r.index} "${r.text}": ${r.fontFile} 缺字形 ${r.missing.join('')}`);
  }
}

/** 解析 + 改写规划 + 改写后复核 + 覆盖检查（不渲染）。slot 决定 800 例外是否适用（未给即不适用）。 */
export function inspectArtSvg(source: string, set: ArtFontSet, opts: ArtRenderOptions = {}): ArtAnalysis {
  const plan = planArtSvg(source, set, opts.slot);
  const a = { runs: plan.runs, problems: plan.problems };
  attachMissing(a, set);
  if (!a.problems.length) a.problems.push(...recheckRewritten(plan.svg, plan.runs, set));
  return { runs: a.runs, problems: a.problems, adjustments: plan.adjustments, svg: plan.svg };
}

export function artResvgOptions(set: ArtFontSet) {
  return {
    fitTo: { mode: 'width' as const, value: ART_WIDTH },
    background: ART_BACKGROUND,
    font: {
      loadSystemFonts: false,
      fontFiles: set.fonts.map((f) => f.file),
      defaultFontFamily: set.sansFamily,
      sansSerifFamily: set.sansFamily,
      monospaceFamily: set.monoFamily,
    },
  };
}

/** 唯一渲染入口：检查不通过即抛错，绝不输出带豆腐块的 PNG。pixels 为解码后的 RGBA，供验证比较。 */
export function renderArtSvg(
  source: string,
  set: ArtFontSet = loadArtFonts(),
  opts: ArtRenderOptions = {},
): { png: Buffer; pixels: Buffer; analysis: ArtAnalysis } {
  const analysis = inspectArtSvg(source, set, opts);
  if (analysis.problems.length)
    throw new Error(`OG art font check failed:\n  ${analysis.problems.join('\n  ')}`);
  const image = new Resvg(analysis.svg, artResvgOptions(set)).render();
  return { png: image.asPng(), pixels: Buffer.from(image.pixels), analysis };
}
