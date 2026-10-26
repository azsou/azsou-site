# OG 图字体

`NotoSansSC-{Regular,Bold}.subset.otf`：Noto Sans SC（© Google / Adobe，SIL Open Font License 1.1）的子集，
只给构建期 OG 分享图（`src/lib/og.ts`）用，不在网页里加载。覆盖 ASCII、常用标点、GB2312 一级字与站内内容出现的全部字符。

重新生成（内容出现新的生僻字时）：

```bash
curl -LO https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
curl -LO https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf
python3 scripts/design/og-font-subset.py NotoSansSC-Regular.otf NotoSansSC-Bold.otf
```
