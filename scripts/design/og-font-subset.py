"""
OG 图字体子集。三种用法：

1) 页面 OG（T9.4，src/lib/og.ts）：Noto Sans SC 400 / 700 → assets/og-fonts/NotoSansSC-{Regular,Bold}.subset.otf
   覆盖 ASCII + 常用标点 + GB2312 一级字 + 站内内容 / 数据 / 文案里出现的全部字符。
   python3 scripts/design/og-font-subset.py <NotoSansSC-Regular.otf> <NotoSansSC-Bold.otf>

2) 素材 OG（R12-F，src/pages/og/art/[slot].png.ts）：Noto Sans SC Black（900）与
   Noto Sans Mono CJK SC Regular（400）→ assets/og-fonts/NotoSansSC-Black.subset.otf、
   assets/og-fonts/NotoSansMonoCJKsc-Regular.subset.otf。只写这两个文件，不动 Regular / Bold。
   覆盖 ASCII + 常用标点 + public/art/*.svg 里所有文字运行（text / tspan）出现的字符。
   python3 scripts/design/og-font-subset.py --art <NotoSansSC-Black.otf> <NotoSansMonoCJKsc-Regular.otf>

3) 覆盖检查：解析 public/art/*.svg，求出每个文字运行的有效 font-family / font-weight / font-style
   （含从祖先元素继承），映射到 assets/og-fonts 里的字体（按字体文件内部 name 表绑定），
   检查字形覆盖。未知 / 未解析的样式、不支持的映射、缺字形都记为失败，退出码 1。
   python3 scripts/design/og-font-subset.py --check [报告.json]

源字体：github.com/notofonts/noto-cjk（OFL 1.1）；素材 OG 的两款固定在提交
523d033d6cb47f4a80c58a35753646f5c3608a78（Noto Sans CJK 2.004），见 assets/og-fonts/SOURCE.md。
"""
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parents[2]
OUT = root / 'assets' / 'og-fonts'
ART = root / 'public' / 'art'
PUNCT = "，。、；：？！「」『』（）《》【】—…·“”‘’ ×→←↑↓•％＋－／"

# 素材 OG 的字体绑定：文件 → 期望的 (usWeightClass, 角色)。家族名一律从文件 name 表读取。
ART_FONTS = {
    'NotoSansSC-Regular.subset.otf': (400, 'sans'),
    'NotoSansSC-Bold.subset.otf': (700, 'sans'),
    'NotoSansSC-Black.subset.otf': (900, 'sans'),
    'NotoSansMonoCJKsc-Regular.subset.otf': (400, 'mono'),
}
# 设计调整（只作用于渲染输入，不改 public/art）：800 没有原生字重，按 700 渲染——
# R12-G 起只允许用于批准例外（与 src/lib/og-art-render.ts 的 ART_WEIGHT_EXCEPTIONS 同一规则）：
# work-3 / work-7 / work-15 里自身声明 font-weight 800、有效字号 13、无子元素、内容恰为「!」的 <text>。
# 其它任何 800 都报错，不归一。
WEIGHT_NORMALIZE = {800: 700}
WEIGHT_EXCEPTION = {'weight': 800, 'slots': ('work-3', 'work-7', 'work-15'), 'tag': 'text', 'text': '!', 'font_size': 13.0}
SVG_NS = '{http://www.w3.org/2000/svg}'
TEXT_TAGS = {'text', 'tspan'}
UNSUPPORTED_TAGS = {'textPath', 'tref', 'altGlyph', 'foreignObject', 'font', 'font-face', 'glyph'}
FONT_ATTRS = {'font-family', 'font-weight', 'font-style', 'font-size'}
SUSPECT_ATTRS = {'font', 'font-variant', 'font-stretch', 'font-size-adjust', 'class'}


def page_chars():
    chars = set(chr(c) for c in range(0x20, 0x7F))
    chars |= set(PUNCT)
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except Exception:
                pass
    for d in ['src/content', 'src/data', 'src/i18n', 'src/lib', 'src/pages']:
        for p in (root / d).rglob('*'):
            if p.is_file() and p.suffix in {'.md', '.mdx', '.json', '.yaml', '.yml', '.ts', '.astro'}:
                chars |= set(p.read_text('utf8', errors='ignore'))
    return {c for c in chars if c.isprintable()}


def subset_one(src, dst, chars, features):
    from fontTools import subset

    opts = subset.Options()
    opts.layout_features = features
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    f = subset.load_font(src, opts)
    s = subset.Subsetter(opts)
    s.populate(text=''.join(sorted(chars)))
    s.subset(f)
    subset.save_font(f, str(dst), opts)
    print(dst.name, dst.stat().st_size)


# ---------- public/art 解析 ----------


def local(tag):
    return tag.split('}', 1)[1] if tag.startswith('{') else tag


def parse_style_attr(value, problems, where):
    """style="a:b; c:d" → dict；只认 font-family/font-weight/font-style/font-size，其它字体相关属性记为问题。"""
    out = {}
    for decl in value.split(';'):
        if not decl.strip():
            continue
        if ':' not in decl:
            problems.append(f'{where}: 无法解析的 style 声明 {decl.strip()!r}')
            continue
        k, v = (x.strip() for x in decl.split(':', 1))
        if k in FONT_ATTRS:
            out[k] = v
        elif k.startswith('font') or k in {'white-space', 'unicode-bidi', 'direction', 'writing-mode'}:
            problems.append(f'{where}: 未支持的 style 属性 {k}:{v}')
    return out


def parse_weight(v):
    v = v.strip()
    if v in ('normal', ''):
        return 400
    if v == 'bold':
        return 700
    if re.fullmatch(r'[1-9]00', v):
        return int(v)
    return None


def parse_size(v):
    m = re.fullmatch(r'(\d+(?:\.\d+)?)(px)?', (v or '').strip())
    return float(m.group(1)) if m else None


def weight_exception(svg_name, el, tag, props):
    """自身声明的 800 是否落在批准例外内；返回 None 表示批准，否则返回拒绝原因。"""
    E = WEIGHT_EXCEPTION
    why = []
    stem = svg_name[:-4] if svg_name.endswith('.svg') else svg_name
    if stem not in E['slots']:
        why.append(f"槽位 {stem} 不在 {'/'.join(E['slots'])}")
    if tag != E['tag']:
        why.append(f"元素 <{tag}> 不是 <{E['tag']}>")
    if parse_size(props.get('font-size')) != E['font_size']:
        why.append(f"有效字号 {props.get('font-size')} ≠ 13")
    if len(list(el)) != 0 or (el.text or '').strip() != E['text']:
        why.append(f"内容不是唯一的「{E['text']}」")
    return '；'.join(why) or None


def scan_art():
    """返回 (runs, problems, files)。runs: 每个非空文字运行的有效样式与文字。"""
    runs, problems, files = [], [], []
    for svg in sorted(ART.glob('*.svg')):
        files.append(svg.name)
        raw = svg.read_text('utf8')
        if re.search(r'<!ENTITY|<\?xml-stylesheet', raw):
            problems.append(f'{svg.name}: 含 DTD 实体或外部样式表，未解析')
        tree = ET.parse(svg)

        def walk(el, inherited, path):
            tag = local(el.tag)
            where = f'{svg.name}:{path}<{tag}>'
            if tag == 'style':
                problems.append(f'{where}: <style> CSS 未解析（不视为已覆盖）')
            if tag in UNSUPPORTED_TAGS:
                problems.append(f'{where}: 不支持的文字元素')
            props = dict(inherited)
            props.pop('_w800_ok', None)
            own_weight = None
            for k, v in el.attrib.items():
                k = local(k)
                if k in FONT_ATTRS:
                    props[k] = v
                    if k == 'font-weight':
                        own_weight = v
                elif k in SUSPECT_ATTRS:
                    problems.append(f'{where}: 未解析的属性 {k}={v!r}')
                elif k == 'style':
                    props.update(parse_style_attr(v, problems, where))
            if own_weight is not None and parse_weight(own_weight) == WEIGHT_EXCEPTION['weight']:
                why = weight_exception(svg.name, el, tag, props)
                if why:
                    problems.append(f'{where}: font-weight {own_weight} 不在批准例外内（拒绝，不归一）：{why}')
                else:
                    props['_w800_ok'] = True
            if tag in TEXT_TAGS:
                if el.text and el.text.strip():
                    runs.append({'file': svg.name, 'path': path, 'tag': tag, 'text': el.text.strip(), **props})
            child_props = {k: v for k, v in props.items() if k != '_w800_ok'}
            for i, ch in enumerate(el):
                walk(ch, child_props, f'{path}/{local(ch.tag)}[{i}]')
                if tag in TEXT_TAGS and ch.tail and ch.tail.strip():
                    runs.append({'file': svg.name, 'path': path + '#tail', 'tag': tag, 'text': ch.tail.strip(), **props})
            if tag not in TEXT_TAGS and el.text and el.text.strip() and tag not in {'title', 'desc', 'style'}:
                problems.append(f'{where}: 非文字元素里有字符数据 {el.text.strip()[:20]!r}')

        walk(tree.getroot(), {}, 'svg')
    return runs, problems, files


def load_bound_fonts():
    from fontTools.ttLib import TTFont

    fonts, problems = {}, []
    for name, (weight, role) in ART_FONTS.items():
        p = OUT / name
        if not p.exists():
            problems.append(f'缺少字体文件 {name}')
            continue
        f = TTFont(p)
        nm = f['name']
        fam = nm.getDebugName(16) or nm.getDebugName(1)
        w = f['OS/2'].usWeightClass
        if w != weight:
            problems.append(f'{name}: usWeightClass={w}，期望 {weight}')
        fonts[name] = {
            'family': fam,
            'weight': w,
            'role': role,
            'cmap': set(f.getBestCmap()),
            'hmtx': f['hmtx'].metrics,
            'best': f.getBestCmap(),
        }
    return fonts, problems


GENERIC_UNSUPPORTED = {'serif', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji', 'fangsong'}


def resolve(run, fonts):
    """按 resvg/usvg 规则模拟：逐个族名；sans-serif/monospace 映射到绑定字体；未加载的具名族跳过；
    无 font-family → defaultFontFamily；字重须精确命中（800 只在批准例外内按设计调整归一为 700）。"""
    sans = {f['family'] for f in fonts.values() if f['role'] == 'sans'}
    mono = {f['family'] for f in fonts.values() if f['role'] == 'mono'}
    if len(sans) != 1 or len(mono) != 1:
        return None, f'绑定家族不唯一 sans={sans} mono={mono}'
    sans, mono = sans.pop(), mono.pop()
    loaded = {f['family'].lower(): f['family'] for f in fonts.values()}
    fam_attr = run.get('font-family')
    family = None
    if fam_attr is None:
        family, how = sans, 'default'
    else:
        for item in fam_attr.split(','):
            item = item.strip().strip('"\'')
            low = item.lower()
            if low == 'sans-serif':
                family, how = sans, 'generic sans-serif'
                break
            if low == 'monospace':
                family, how = mono, 'generic monospace'
                break
            if low in GENERIC_UNSUPPORTED:
                return None, f'不支持的通用族 {item}'
            if low in loaded:
                family, how = loaded[low], f'named {item}'
                break
        if family is None:
            return None, f'font-family {fam_attr!r} 无可解析项（不允许回退）'
    style = run.get('font-style', 'normal').strip()
    if style != 'normal':
        return None, f'不支持的 font-style {style}'
    w_raw = run.get('font-weight', 'normal')
    w = parse_weight(w_raw)
    if w is None:
        return None, f'无法解析的 font-weight {w_raw!r}'
    if w == WEIGHT_EXCEPTION['weight'] and not run.get('_w800_ok'):
        return None, f'font-weight {w_raw} 不在批准例外内（拒绝）'
    w_eff = WEIGHT_NORMALIZE.get(w, w) if w == WEIGHT_EXCEPTION['weight'] else w
    cands = [n for n, f in fonts.items() if f['family'] == family and f['weight'] == w_eff]
    if len(cands) != 1:
        return None, f'{family} 没有精确字重 {w_eff}（原始 {w_raw}）'
    return {'family': family, 'via': how, 'weight_declared': w, 'weight_used': w_eff, 'font_file': cands[0]}, None


def check(report_path=None):
    runs, problems, files = scan_art()
    fonts, fproblems = load_bound_fonts()
    problems += fproblems
    out_runs = []
    for r in runs:
        res, err = resolve(r, fonts) if fonts else (None, '字体未加载')
        row = {k: r.get(k) for k in ('file', 'path', 'tag', 'text', 'font-family', 'font-weight', 'font-style')}
        if err:
            row['error'] = err
            problems.append(f"{r['file']}:{r['path']}: {err}")
        else:
            missing = [c for c in r['text'] if ord(c) not in fonts[res['font_file']]['cmap']]
            row.update(res)
            row['missing'] = missing
            if missing:
                problems.append(f"{r['file']}:{r['path']}: {res['font_file']} 缺字形 {missing}")
        out_runs.append(row)
    # 等宽字体实际步进（hmtx），不依赖 isFixedPitch 与文件名
    mono_report = {}
    for n, f in fonts.items():
        if f['role'] != 'mono':
            continue
        widths = {}
        for cp, g in f['best'].items():
            widths.setdefault(f['hmtx'][g][0], []).append(cp)
        mono_report[n] = {str(w): len(v) for w, v in sorted(widths.items())}
        used = sorted({c for r in out_runs if r.get('font_file') == n for c in r['text']})
        mono_report[n + ':used'] = {c: f['hmtx'][f['best'][ord(c)]][0] for c in used if ord(c) in f['best']}
    rep = {
        'svg_files': len(files),
        'text_files': sorted({r['file'] for r in runs}),
        'runs': out_runs,
        'fonts': {n: {'family': f['family'], 'weight': f['weight'], 'role': f['role'], 'cmap': len(f['cmap'])} for n, f in fonts.items()},
        'weight_normalize': {str(k): v for k, v in WEIGHT_NORMALIZE.items()},
        'weight_exception': {k: list(v) if isinstance(v, tuple) else v for k, v in WEIGHT_EXCEPTION.items()},
        'mono_advances': mono_report,
        'problems': problems,
        'result': 'FAIL' if problems else 'PASS',
    }
    s = json.dumps(rep, ensure_ascii=False, indent=1)
    if report_path:
        pathlib.Path(report_path).write_text(s + '\n', 'utf8')
    print(f"svg={len(files)} text_files={len(rep['text_files'])} runs={len(runs)} problems={len(problems)} result={rep['result']}")
    for p in problems:
        print('PROBLEM', p)
    return 1 if problems else 0


def art_subsets(black_src, mono_src):
    runs, problems, _ = scan_art()
    if problems:
        for p in problems:
            print('PROBLEM', p)
        sys.exit(1)
    art = set(''.join(r['text'] for r in runs))
    base = set(chr(c) for c in range(0x20, 0x7F)) | set(PUNCT)
    chars = {c for c in base | art if c.isprintable()}
    OUT.mkdir(parents=True, exist_ok=True)
    subset_one(black_src, OUT / 'NotoSansSC-Black.subset.otf', chars, ['kern', 'palt'])
    # 等宽：不保留 palt（比例宽度替换），保持等宽网格
    subset_one(mono_src, OUT / 'NotoSansMonoCJKsc-Regular.subset.otf', chars, ['kern'])
    print('chars', len(chars), 'art chars', ''.join(sorted(c for c in art if ord(c) > 0x7F)))


def page_subsets(regular_src, bold_src):
    chars = page_chars()
    OUT.mkdir(parents=True, exist_ok=True)
    for src, name in zip([regular_src, bold_src], ['NotoSansSC-Regular.subset.otf', 'NotoSansSC-Bold.subset.otf']):
        subset_one(src, OUT / name, chars, ['kern', 'palt'])
    print('chars', len(chars))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['--check']:
        sys.exit(check(a[1] if len(a) > 1 else None))
    elif a[:1] == ['--art'] and len(a) == 3:
        art_subsets(a[1], a[2])
    elif len(a) == 2 and not a[0].startswith('--'):
        page_subsets(a[0], a[1])
    else:
        print(__doc__)
        sys.exit(2)
