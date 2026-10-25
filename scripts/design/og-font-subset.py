"""
OG 图字体子集（T9.4）：Noto Sans SC 400 / 700 → assets/og-fonts/*.otf
覆盖 ASCII + 常用标点 + GB2312 一级字 + 站内内容 / 数据 / 文案里出现的全部字符。
用法：python3 scripts/design/og-font-subset.py <NotoSansSC-Regular.otf> <NotoSansSC-Bold.otf>
（源字体：github.com/notofonts/noto-cjk Sans/SubsetOTF/SC，OFL 1.1）
内容新增生僻字时 og 生成会回退到 □ 并在构建日志警告；重新运行本脚本即可。
"""
import pathlib, sys
from fontTools import subset

root = pathlib.Path(__file__).resolve().parents[2]
chars = set(chr(c) for c in range(0x20, 0x7F))
chars |= set("，。、；：？！「」『』（）《》【】—…·“”‘’ ×→←↑↓•％＋－／")
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
chars = {c for c in chars if c.isprintable()}
out = root / 'assets' / 'og-fonts'
out.mkdir(parents=True, exist_ok=True)
for src, name in zip(sys.argv[1:3], ['NotoSansSC-Regular.subset.otf', 'NotoSansSC-Bold.subset.otf']):
    opts = subset.Options(); opts.layout_features = ['kern', 'palt']; opts.name_IDs = ['*']; opts.notdef_outline = True
    f = subset.load_font(src, opts)
    s = subset.Subsetter(opts); s.populate(text=''.join(chars)); s.subset(f)
    subset.save_font(f, str(out / name), opts)
    print(name, (out / name).stat().st_size)
print('chars', len(chars))
