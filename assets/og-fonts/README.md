# OG 图字体

全部是 Noto Sans CJK（© 2014-2021 Adobe，SIL Open Font License 1.1，全文见同目录 `LICENSE`）的子集，
只在构建期给 OG 分享图用，不在网页里加载。来源、哈希、内部名与许可结论见 `SOURCE.md`。

| 文件 | 内部家族（name 16 → 1） | usWeightClass | 用途 |
| --- | --- | --- | --- |
| `NotoSansSC-Regular.subset.otf` | Noto Sans SC | 400 | 页面 OG（`src/lib/og.ts`）+ 素材 OG |
| `NotoSansSC-Bold.subset.otf` | Noto Sans SC | 700 | 页面 OG + 素材 OG |
| `NotoSansSC-Black.subset.otf` | Noto Sans SC（name 1 为 Noto Sans SC Black） | 900 | 素材 OG（`src/pages/og/art/[slot].png.ts`） |
| `NotoSansMonoCJKsc-Regular.subset.otf` | Noto Sans Mono CJK SC | 400 | 素材 OG 等宽标签 |

Regular / Bold 覆盖 ASCII、常用标点、GB2312 一级字与站内内容出现的全部字符。
Black / Mono 覆盖 ASCII、常用标点与 `public/art/*.svg` 文字运行里出现的全部字符。

素材 OG 只加载这四个文件（`loadSystemFonts: false`），按字体内部名绑定 `defaultFontFamily` /
`sansSerifFamily` = Noto Sans SC、`monospaceFamily` = Noto Sans Mono CJK SC。
素材里 3 处 13px 感叹号声明 `font-weight="800"`，没有原生 800：渲染时只在内存里按设计调整归一为 700（Bold）。

重新生成：

```bash
# 页面 OG（Regular / Bold；内容出现新的生僻字时）
curl -LO https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
curl -LO https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf
python3 scripts/design/og-font-subset.py NotoSansSC-Regular.otf NotoSansSC-Bold.otf

# 素材 OG（Black / Mono；固定提交，素材出现新字符时）
C=523d033d6cb47f4a80c58a35753646f5c3608a78
curl -LO https://raw.githubusercontent.com/notofonts/noto-cjk/$C/Sans/SubsetOTF/SC/NotoSansSC-Black.otf
curl -LO https://raw.githubusercontent.com/notofonts/noto-cjk/$C/Sans/Mono/NotoSansMonoCJKsc-Regular.otf
python3 scripts/design/og-font-subset.py --art NotoSansSC-Black.otf NotoSansMonoCJKsc-Regular.otf

# 覆盖检查（Python，fontTools）与渲染侧检查（Node，与路由同一渲染函数）
python3 scripts/design/og-font-subset.py --check
node scripts/design/og-art-verify.mjs
```
