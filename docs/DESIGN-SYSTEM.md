# AZ Studio 设计系统 v1（提案）

> 状态：提案（2026-10-25），由 P9「设计系统与商业化视觉」落地。依据见 [DESIGN-AUDIT.md](./DESIGN-AUDIT.md) §5。
> 原则：**少即是一致**。每一类数值只允许下面列出的档位；新增档位必须改本文 + token 文件，并通过评审。
> v1.1（2026-10-25 第二轮）：新增 §16–§22（状态矩阵、UI 图标、文案、图片 / OG、邮件、视口与系统模式、中文排版）；断点在 600 / 900 / 1200 之外新增 **1600 宽屏档**（只扩容器与列数，见 §21）。
> 单一来源：`tokens/*.json`（Style Dictionary）→ 生成 `src/styles/tokens.css`、`src/lib/tokens.ts`、`public/cms/preview.css`。组件只能用 `var(--…)`，由 stylelint 强制（见 DESIGN-QA.md）。

## 1. 基础

- 基准单位 **4px**；布局间距优先 8 的倍数。
- 内容宽度 `--content-max: 1200px`，阅读宽度 `--reading-max: 680px`（中文约 38–42 字/行），页面左右边距：390→16、600→24、900+→32。
- 字体栈（保持系统字体，零下载）：
  - `--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", Roboto, "Helvetica Neue", Arial, sans-serif;`
  - `--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace;`
  - 数字列（价格、版本、计数）加 `font-variant-numeric: tabular-nums`。
- 中文排版全局：`text-spacing-trim: normal`（Chrome 默认挤压标点）、标题 `text-wrap: balance`、正文 `text-wrap: pretty`、`line-break: strict`、`word-break: normal; overflow-wrap: anywhere`（只用于 URL / 长英文）。中英之间、中文与数字之间**手写一个半角空格**（`text-autospace` 普及前）；全角标点前后不加空格。

## 2. 字阶（Type scale）

固定 px，不用 vw 流式（只有首页 hero `display` 允许 `clamp`，且两端取档位值）。每档绑定 **字号 / 行高 / 字重 / 字距**，用组合类 `.t-<name>` 或 mixin，禁止单独改其中一项。

| Token      | 用途                         | 字号            | 行高 zh   | 行高 en   | 字重      | 字距              |
| ---------- | ---------------------------- | --------------- | --------- | --------- | --------- | ----------------- |
| `display`  | 首页 hero H1                 | 48（390 宽 34） | 1.20 (58) | 1.10      | 700       | -0.02em（仅拉丁） |
| `title-1`  | 页面 H1（列表 / 详情名）     | 32（390 宽 28） | 1.25 (40) | 1.20      | 700       | -0.01em           |
| `title-2`  | 区块标题 H2                  | 22              | 1.35 (30) | 1.27 (28) | 600       | 0                 |
| `title-3`  | 卡片标题（大）、对话框标题   | 17              | 1.41 (24) | 1.29 (22) | 600       | 0                 |
| `headline` | 卡片标题（小）、表头         | 15              | 1.47 (22) | 1.33 (20) | 600       | 0                 |
| `body`     | 正文、文章                   | 17              | 1.76 (30) | 1.53 (26) | 400       | 0                 |
| `body-sm`  | 卡片简介、表单说明、列表正文 | 15              | 1.60 (24) | 1.47 (22) | 400       | 0                 |
| `meta`     | 元信息、标签、按钮小字       | 13              | 1.54 (20) | 1.38 (18) | 400 / 600 | 0                 |
| `caption`  | 徽标数字、角标、时间戳       | 12              | 1.50 (18) | 1.33 (16) | 600       | 0.01em            |

- **字重只允许 400 / 600 / 700**（Windows 微软雅黑只有 400/700，600 会落到 700；层级不靠字重，靠字号 + 颜色）。
- 最小字号 12px；正文类 ≥ 15px；按钮文字 15/600（主按钮）、13/600（小按钮）。
- 英文页面（`:lang(en)`）自动换用 en 行高列。
- 一页最多出现 **7 档**；同一卡片内最多 **3 档**（标题 / 正文 / meta）。

## 3. 色彩角色

| 角色                                       | 浅色                                                                                                                  | 深色                                  | 用途                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `bg`                                       | #F5F5F7                                                                                                               | #000000                               | 页面底                                                                    |
| `surface`                                  | #FFFFFF                                                                                                               | #1C1C1E                               | 卡片、面板                                                                |
| `surface-2`                                | #FFFFFF                                                                                                               | #2C2C2E                               | 卡片上的浮层、输入框、图标垫板                                            |
| `fill`                                     | rgba(120,120,128,.12)                                                                                                 | rgba(120,120,128,.24)                 | 胶囊、分段控件底、骨架屏                                                  |
| `fill-strong`                              | rgba(120,120,128,.20)                                                                                                 | rgba(120,120,128,.36)                 | hover / pressed                                                           |
| `separator`                                | rgba(60,60,67,.16)                                                                                                    | rgba(84,84,88,.6)                     | 分隔线、描边                                                              |
| `label`                                    | #1D1D1F                                                                                                               | #F5F5F7                               | 主文字                                                                    |
| `label-2`                                  | rgba(60,60,67,.82)                                                                                                    | rgba(235,235,245,.72)                 | 次文字（≥ 4.5:1）                                                         |
| `label-3`                                  | rgba(60,60,67,.76)                                                                                                    | rgba(235,235,245,.6)                  | 元信息（≥ 4.5:1，仅 ≥ 13px）                                              |
| `accent`（品牌）                           | #2F7D4F                                                                                                               | #3FB56C                               | 主按钮、选中态、品牌强调                                                  |
| `on-accent`                                | #FFFFFF                                                                                                               | #00210E                               | 主按钮文字                                                                |
| `link`                                     | #0062C4                                                                                                               | #5EA8FF                               | 文内链接（**只在正文段落里**；UI 内的「查看全部」等用 accent 或 label-2） |
| `success / warning / danger / info`        | #176B2E / #B35C00 / #C42B1C / #0058B0                                                                                 | #4CD27A / #FFB340 / #FF6B5E / #6AB0FF | 状态色，配 12% 透明底做徽标                                               |
| `focus`                                    | #0058B0（不透明 outline）                                                                                             | #64A8FF                               | 焦点环                                                                    |
| `hue-{blue,green,teal,orange,purple,pink}` | 6 个封面色相，浓度 `--cover-strong 22%` / `--cover-soft 8%`（深色 28% / 12%），渐变一律「左上 strong → 右下 surface」 |                                       | 卡片封面柔光                                                              |

> T9.1 落地注：`label-3` 浅色由 .70 改为 .76（.70 在 #F5F5F7 上只有 4.30:1，不满足 4.5:1，单测 `tests/unit/tokens.test.ts` 守护）；`focus` 改为不透明色画 outline（§16）。数值以 `tokens/*.json` 为准。

规则：一个视图里**只有一个主色按钮**；状态徽标只用 4 个状态色；禁止在组件里写 hex / rgb（token 文件除外）。

## 4. 间距、尺寸、圆角、阴影、层级

- **间距刻度**：`0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80`（token `--space-0…--space-20`）。
  - 组件内：图标与文字 8–12；卡片内边距 16（紧凑）/ 20（标准）/ 24（精选）。
  - 卡片之间 gap：网格 16（390–899）/ 20（900+）；横向货架 16。
  - 区块之间：64（900+）/ 48（< 900）；区块标题与内容 16；标题与副标题 4。
- **控件高度**：28（chip、小按钮，触屏下 32）/ 36（次级按钮、分段控件）/ 44（主按钮、输入框、导航按钮）/ 52（hero 搜索框）。
- **圆角**（5 档）：`--radius-xs 6`（徽标、复选框）/ `sm 10`（输入框、小按钮、缩略图）/ `md 14`（卡片、面板）/ `lg 20`（精选卡、对话框、hero 面板）/ `pill 999`；图标使用 squircle（见 §6），不在此表。
- **阴影 / 层级**（3 档 + 描边）：
  - `--elev-0`：无阴影 + `inset 0 0 0 0.5px separator`（静止卡片，深色模式只用描边）
  - `--elev-1`：`0 1px 2px rgba(0,0,0,.06), 0 1px 1px rgba(0,0,0,.04)`（悬停卡片、输入框）
  - `--elev-2`：`0 8px 24px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.06)`（弹层、下拉、对话框、悬停精选卡）
  - 深色模式阴影不可见，悬停改为 `surface → surface-2` 背景提亮。
- **z-index**：`base 0 / raised 10（吸顶表头、悬浮卡）/ sticky 100（顶部导航、底部 TabBar）/ overlay 200（遮罩）/ modal 300（对话框、搜索面板）/ toast 400 / tooltip 500`。

## 5. 动效

| Token           | 值                        | 用途                             |
| --------------- | ------------------------- | -------------------------------- |
| `--dur-instant` | 80ms                      | 按压反馈、复选                   |
| `--dur-fast`    | 160ms                     | hover 颜色 / 阴影、图标缩放      |
| `--dur`         | 240ms                     | 卡片上浮、展开收起、Tab 切换     |
| `--dur-slow`    | 360ms                     | 对话框、搜索面板进出、页面级过渡 |
| `--ease-out`    | cubic-bezier(.22,1,.36,1) | 进入                             |
| `--ease-in`     | cubic-bezier(.4,0,1,1)    | 退出                             |
| `--ease-spring` | cubic-bezier(.32,.72,0,1) | 位移类（卡片、面板）             |

- 只动画 `transform / opacity / box-shadow / background-color`；悬停上浮 2px、图标放大 1.04（不再用 1.06）、封面图 1.03；按压 `scale(.98)`。
- `prefers-reduced-motion: reduce` → 所有位移/缩放为 0，保留颜色变化；轮播 `scroll-behavior: auto`。
- 骨架屏 shimmer 1.2s，减少动态时为静态 `fill`。

## 6. 图标规范

### 6.1 容器尺寸（只允许 5 档）

| 档        | 尺寸 | 圆角（squircle 等效） | 用途                              |
| --------- | ---- | --------------------- | --------------------------------- |
| `icon-xs` | 32   | 7                     | 列表内联、标签、搜索面板结果      |
| `icon-sm` | 40   | 9                     | 最近更新行、分类卡、评论头像位    |
| `icon-md` | 56   | 12.5                  | 磁贴、行卡（替代现在的 64）       |
| `icon-lg` | 72   | 16                    | 精选卡、平台入口                  |
| `icon-xl` | 112  | 25                    | 详情页头部（替代现在的 96 / 120） |

- 遮罩：统一 **squircle**（连续曲率），CSS 用 `border-radius: 22.37%`（iOS 等效）+ `mask-image` SVG superellipse（n≈5）以获得连续曲率；源图**必须是满幅方块**，不得自带圆角或阴影。
- 描边：所有图标 `inset 0 0 0 0.5px rgba(0,0,0,.08)`（深色 `rgba(255,255,255,.10)`），保证白底图标在白卡片上有边界。
- 阴影：静止无阴影；仅 `icon-lg / xl` 使用 `--elev-1`。

### 6.2 源图与安全区

- 源图 1024×1024（第三方最低 512×512），sRGB，PNG/SVG；构建输出 AVIF + WebP，尺寸 = 容器 ×1 / ×2（32/64、40/80、56/112、72/144、112/224）。
- **安全区**：logo 主体外接框边长 = 画布的 **72%**（允许 68%–76%）；满幅插画型图标（自研应用）允许 100%，但重要元素在 80% 圆内。
- 光学修正：圆形 logo 用 76%、横长 logo 按宽度 80%、窄高 logo 按高度 72%。

### 6.3 底色规范化（构建期自动判定 + 人工可覆盖 `iconBg`）

| 源图类型                                     | 判定                       | 处理                                                                                                                                       |
| -------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 彩色满幅（品牌底色）                         | 边缘像素饱和度高、非白非黑 | 保留，只做安全区校验                                                                                                                       |
| 白底 / 浅底 logo                             | 边缘 L* > 92               | 去底 → 放到 `icon-plate`（浅色 #FFFFFF，深色 #F2F2F7），主体缩放到 72%                                                                     |
| 透明底 logo                                  | alpha 边缘 < 10%           | 同上，放 `icon-plate`                                                                                                                      |
| 深色字形（黑 logo 黑底，如 Zed / v0 / Bolt） | 边缘 L* < 12               | 浅色模式保留黑底；深色模式黑底与页面融为一体 → 加 `rgba(255,255,255,.10)` 描边 + 底色抬到 #1C1C1E；无法辨认的单色字形提供 `@dark` 反色变体 |
| 品牌字标（文字 logo）                        | 人工标注                   | 允许，但必须按安全区缩放                                                                                                                   |

- 同一货架 / 网格内：**白垫板图标数量 > 60% 时**，该区块卡片背景用 `surface` 而不是白，保证图标与卡片有对比（浅色下卡片 #FFFFFF 时垫板加描边）。

### 6.4 兜底 Monogram（只在资源确实缺失时）

- 底色：条目 `hue` 的 strong 色（不是品牌绿统一底）；文字：#FFF，字重 600。
- 内容：拉丁名取首字母 1–2 个大写（「EmberDeep」→「E」或「ED」）；中文名取**首字 1 个**（「地牢生成可视化」→「地」），不截两字。
- 字号 = 容器 × 0.42（拉丁 2 字母 × 0.36）。
- CI 报告所有使用 monogram 的条目（视为待补资源，不阻断构建）。游戏 / 自研应用缺图标**阻断构建**。

### 6.5 UI 图标

- 一套线性图标（SF Symbols 风格，推荐 Lucide 子集或现有 `Icon.astro` 统一线宽 1.75px、24 网格、圆角端点），尺寸 16 / 20 / 24，与文字同色（`currentColor`）。
- **2026-10-25 第二轮更新**：现有 `Icon.astro` 实为 9 个**填充式**图标（全部 20px 渲染），与本条矛盾；完整规范以 **§17** 为准（线性为主、TabBar 选中态用填充变体、字符图标禁用）。
- 分类卡用单个 24px 线性分类图标 + 圆形 `fill` 底（40），不再叠放应用图标。

## 7. 缩略图与封面

| 类型          | 比例                                                   | 卡片渲染宽（1440）   | 源图最小   | 格式                |
| ------------- | ------------------------------------------------------ | -------------------- | ---------- | ------------------- |
| 视频缩略图    | 16:9                                                   | 380                  | 1280×720   | AVIF/WebP 400w/800w |
| 游戏封面      | 16:10 → **改为 16:9** 与视频统一                       | 380                  | 1600×900   | 同上                |
| 作品 / 截图卡 | 4:3                                                    | 280                  | 1200×900   | 同上                |
| 文章头图      | 2:1（OG 1.91:1 另出）                                  | 380 / 详情 680       | 1360×680   | 同上                |
| 应用截图      | 桌面 16:10、手机 9:19.5、网页 16:9（按 `device` 字段） | 高度固定 320（详情） | 原始分辨率 | 同上                |
| OG 图         | 1200×630                                               | —                    | —          | PNG/JPEG ≤ 300KB    |

- 所有图片容器 `aspect-ratio` 固定 + `object-fit: cover`，图片带 `width/height`，圆角 `--radius-sm`（嵌在卡片里时与卡片上沿同圆角）。
- 缺图：用该条目 hue 的渐变 + 居中 `icon-lg` 图标（不是空白、不是文字）。
- 单张 ≤ 120 KB（400w AVIF）；首屏外懒加载。

## 8. 栅格与断点

断点（只 4 个，移动优先 `min-width`）：`sm ≥ 600`、`md ≥ 900`、`lg ≥ 1200`；（< 600 为 base）。组件内部优先 **容器查询**（`@container`），不再按视口写零碎断点。

| 卡片类型                            | 最小卡宽 | base(<600)    | sm  | md  | lg                                   |
| ----------------------------------- | -------- | ------------- | --- | --- | ------------------------------------ |
| 行卡（图标 + 文字，App 行）         | 320      | 1             | 2   | 2   | 3                                    |
| 磁贴（紧凑图标卡）                  | 240      | 1（列表形式） | 2   | 3   | 4                                    |
| 媒体卡（视频 / 游戏 / 文章 / 作品） | 280      | 1             | 2   | 3   | 4（视频保持 3 也可，但全站同类统一） |
| 精选卡                              | 480      | 1             | 1   | 2   | 2                                    |
| 分类卡                              | 160      | 2             | 3   | 4   | 6（12 项正好 2 行）                  |

- 实现：`grid-template-columns: repeat(var(--cols), minmax(0, 1fr))`，`--cols` 由断点设定，**不**用 `auto-fill` 产生的非整数行。
- 同一网格内卡片**等高**（`grid-auto-rows: 1fr` 或卡片内 flex 让 footer 贴底）。
- 中英文页面同一类型列数一致。

## 9. 横向货架（轮播）规则

- 适用：首页「编辑精选」「自研应用」等 ≤ 2 处；其余用网格 + 「查看全部」。
- 每屏**整数张 + 固定露出**：卡宽 = `(容器宽 − gap×(n−1) − peek) / n`，`peek = 48px`（只露出下一张的边缘，作为「还有更多」提示）；n 按 §8 列数。
- 隐藏原生滚动条：`scrollbar-width: none; &::-webkit-scrollbar { display: none; }`。
- `scroll-snap-type: x mandatory; scroll-padding-inline: 页面边距`；子项 `scroll-snap-align: start`。
- 左右边缘渐隐：`mask-image: linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% − 48px), transparent)`，到头时对应一侧不渐隐（JS 切换 `data-at-start/end`）。
- 按钮：36px 圆形 `fill` 按钮，放在区块标题行右侧（现有位置保留），溢出才显示、到头禁用，`aria-controls`，每次滚动一屏。
- 键盘：条目可 Tab 聚焦，聚焦时 `scrollIntoView({block:'nearest', inline:'nearest'})`。
- 触屏：保留原生惯性滑动；不自动播放。

## 10. 卡片解剖与字数上限

字数单位：**汉字 = 1，拉丁字母 / 数字 / 半角符号 = 0.5**（`zhLength()`）。上限由「卡宽 ÷ 字号」算出，留 10% 余量。

| 卡片                                    | 结构（自上而下）                                                                  | 标题                                     | 一句话 tagline | 简介                   | meta            | 高度       |
| --------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------- | -------------- | ---------------------- | --------------- | ---------- |
| **行卡**（App 行）                      | 图标 md 56 · 标题 · tagline · meta（分类 · 价格）· 右侧「获取」按钮               | ≤ 14，1 行                               | ≤ 16，1 行     | 不显示                 | ≤ 2 项，1 行    | 固定 88    |
| **磁贴**（紧凑）                        | 图标 md · 标题 · tagline                                                          | ≤ 12，1 行                               | ≤ 14，1 行     | —                      | —               | 固定 80    |
| **精选卡**                              | eyebrow（≤ 2 项）· 图标 lg 72 · 标题 · tagline · 简介 · 底栏（平台图标 + 主按钮） | ≤ 16，1 行                               | ≤ 18，1 行     | **2 行截断，32–56 字** | 平台以图标表示  | 固定 280   |
| **AI 工具卡**（目录）                   | 图标 md · 标题 · 开发者（≤ 12）· 简介 · 标签 ≤ 3 · 底栏（价格 · 平台图标）        | ≤ 14                                     | —              | **2 行截断，40–64 字** | 2 项            | 网格内等高 |
| **媒体卡**（视频 / 游戏 / 文章 / 作品） | 封面 16:9 · 标题 · meta（频道/类型 · 时长/日期）                                  | **2 行截断，≤ 34**（视频）/ ≤ 36（文章） | —              | 不显示                 | ≤ 2 项          | 等高       |
| **最近更新行**                          | 图标 sm 40 · 标题 · 版本号 · 相对时间                                             | ≤ 14                                     | —              | —                      | 版本 + 相对时间 | 固定 64    |
| **分类卡**                              | 分类线性图标 · 名称 · 数量                                                        | ≤ 6                                      | —              | —                      | 「N 个」        | 固定 96    |

内容 schema 对应（P9 落地）：

| 集合          | 字段                               | 规则                                        |
| ------------- | ---------------------------------- | ------------------------------------------- |
| apps / tools  | `title`                            | ≤ 14（超长用 `shortTitle`）                 |
| apps / tools  | `tagline`（新，卡片专用）          | 必填，6–16                                  |
| apps          | `summary`                          | 32–56（精选卡 2 行）；详情页长介绍用正文    |
| tools         | `summary`                          | 40–64（AI 工具卡 2 行）；详情页长介绍用正文 |
| tools         | `developer.short`（新）            | ≤ 12，卡片显示；全称放详情                  |
| videos        | `title`                            | ≤ 34（原标题保留在 `originalTitle`）        |
| articles      | `title` ≤ 36；`description` 60–110 |                                             |
| games / works | `icon` 或 `cover` 必填             |                                             |

截断规则：标题与 tagline 用单行省略号仅作安全网（CI 以「出现截断」为失败，见 DESIGN-QA §2.5）；简介允许 `line-clamp: 2`，但内容长度应落在范围内使截断很少发生。

## 11. 交互状态

> 焦点环画法、hover 媒体查询、visited / error / 强制色等完整状态见 **§16**（第二轮更新，冲突时以 §16 为准）。

| 状态                      | 卡片                                                     | 按钮（主）                          | 按钮（次 / chip）                   | 输入框                        |
| ------------------------- | -------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------- |
| 默认                      | `surface` + `elev-0`                                     | `accent` 底 + `on-accent` 字        | `fill` 底 + `label` 字              | `surface-2` + 1px `separator` |
| hover（仅 `hover:hover`） | 上浮 2px + `elev-1`（深色：背景 `surface-2`），图标 1.04 | 底色加深 8%（`color-mix`）          | `fill-strong`                       | 描边 `label-3`                |
| focus-visible             | `focus` 环（卡片环绕整卡）                               | `focus` 环                          | `focus` 环                          | `focus` 环 + 描边 `accent`    |
| pressed                   | `scale(.98)` 80ms                                        | `scale(.98)` + 加深 14%             | `scale(.98)`                        | —                             |
| selected                  | —                                                        | —                                   | `accent` 12% 底 + `accent` 字 + 600 | —                             |
| disabled                  | 不可点击，`opacity .5`                                   | `opacity .4`，`cursor: not-allowed` | 同                                  | `fill` 底                     |
| loading                   | 骨架屏（同尺寸灰块）                                     | 文字换为 16px spinner，宽度不变     | 同                                  | 右侧 spinner                  |

- 整卡可点：标题链接 `::after` 撑满卡片；卡内次级链接 `position: relative; z-index: raised`。
- 只显示一个 CTA；「查看」类文字链接改为整卡点击 + 右下角 chevron 或「获取 / 打开」按钮。

## 12. 空状态 / 加载 / 错误

- **空状态**：图标（48 线性，`label-3`）+ 一句话标题（title-3）+ 一句说明（body-sm label-2）+ 至多一个按钮；区块级空状态优先**整块隐藏**（无数据的区块不渲染）。
- **加载**：首屏数据区用骨架（与真实卡片同尺寸，避免 CLS）；> 400ms 才显示 spinner；按钮内 spinner 不改变宽度。
- **错误**：内联错误条（`danger` 12% 底 + 图标 + 文案 + 「重试」），不使用 alert()；表单字段错误放字段下方，`aria-describedby` 关联。
- **评分 / 下载为 0**：不画空柱状图、不显示「0 次下载」；改为「还没有评价 · 写第一条」。
- **数据日期**：展示相对时间（< 7 天「3 天前」，< 1 年「3 个月前」），`<time datetime>` 带绝对日期 tooltip。

## 13. 页面骨架

- 顶部导航：高 52；≥ 1200 显示 Logo + 7 个主栏目 + 搜索 / 主题 / 语言 / 账户；900–1199 显示 Logo + 5 个主栏目 +「更多」；< 900 显示 Logo + 搜索 + 账户，主栏目进底部 TabBar（5 项）。导航文字 `white-space: nowrap`。
- 区块标题 `SectionHeader`：title-2 + 可选副标题（meta label-2，≤ 24 字，1 行）+ 右侧「查看全部」（meta 600 accent + chevron 16）+ 货架按钮。
- 页面头 `PageHead`：eyebrow（caption accent）· title-1 · 导语（body-sm label-2，≤ 60 字，≤ 2 行）。

## 14. 后台（/admin/）规范

- **独立 App Shell**：左侧栏 240（< 900 收为顶部分段 / 抽屉）、顶栏 52（站点名、环境标签、用户），不显示前台导航与页脚；内容区最大 1280，左右 32。
- **统计卡**：等宽网格（lg 4 列 / md 2 列 / base 1 列），数字 28/700 tabular-nums，标签 13 label-2，趋势 12。
- **数据表**：
  - 行高 52（紧凑 44），表头吸顶（`z: raised`），斑马纹关闭、悬停行 `fill`；
  - 列：复选（48，命中区 32）· 主列（标题 15/600 一行 + 摘要 13 label-2 一行纯文本，去 Markdown）· 次列 ≤ 4 · 操作列（一个「⋯」菜单 + 最常用 1 个快捷按钮）；
  - 选中行时顶部出现批量工具栏（「已选 N 项」+ 操作 + 取消）；
  - 窄屏（< 900）：表格转卡片列表，每卡 主列 + 2 个 meta + ⋯。
  - 状态用状态徽标（6 圆角，12/600）。
- **表单**：标签在上（13/600），输入框 44 高，说明文字 13 label-2 在下；必填用「*」+ `aria-required`；字数计数在右下（`0 / 120`）；分组用 `fieldset` 卡片，主按钮右下（「保存」accent）+ 次按钮「取消」；危险操作二次确认对话框，确认按钮 `danger`。
- **筛选条**：搜索框 + ≤ 3 个下拉（自定义 Listbox，非原生外观）+「重置」；筛选状态写入 URL。

## 15. CMS（Decap）规范

- `CMS.registerPreviewStyle('/cms/preview.css')`（由 token 生成）+ 每个集合注册预览模板，直接复用卡片与详情 CSS，编辑时看到真实卡片（含截断）。
- 字段 `hint` 统一写「用于哪里 · 字数范围」，例：`卡片一句话 · 6–16 字`；自定义 `string-count` widget 显示实时 `zhLength` 与超限红字（保存前校验 `pattern`）。
- 图标字段：自定义 widget 显示 56 / 112 两档预览（含遮罩与垫板）+ 安全区参考线；上传后提示「将自动规范化」。
- 品牌对齐：Decap 的主色、圆角、字体通过 `preview.css` 无法改编辑器外壳 —— 外壳保持 Decap 默认，但在 `config.yml` 设置 `logo_url`、`locale: zh_Hans`，并在 `/cms/` 页加一行站点色顶栏说明「编辑后会开 PR，由站长合并」。

---

> 以下 §16–§22 为 2026-10-25 第二轮审计（[DESIGN-AUDIT-2.md](./DESIGN-AUDIT-2.md)）新增的规则，优先级与 §1–§15 相同。

## 16. 状态矩阵（完整版，取代 §11 中的焦点与 hover 细节）

**焦点环（唯一画法）**

```css
:focus-visible {
  outline: 2px solid var(--c-focus); /* 不透明；浅色 #0058B0，深色 #64A8FF；对相邻底色 ≥ 3:1 */
  outline-offset: 2px;
  border-radius: inherit; /* 现代浏览器 outline 跟随圆角 */
}
/* 整卡链接：焦点画在卡片上 */
.card:has(.card__link:focus-visible) {
  outline: 2px solid var(--c-focus);
  outline-offset: 2px;
}
```

- 禁止 `outline: none` 搭配 `box-shadow` 画焦点（强制色模式下 box-shadow 被清空，焦点消失）。
- 焦点环宽 2px、偏移 2px，全站一种；表单输入框额外把边框改 `accent`。

**hover 只在有指针的设备**：所有 hover 视觉放进 `@media (hover: hover) and (pointer: fine) { … }`；`a:hover` 下划线同样。触屏用 `:active` 按压态反馈。

**全局**：`html { -webkit-tap-highlight-color: transparent; }`（必须同时有 `:active` 按压态）。

| 状态               | 链接（正文）                                          | 链接（导航 / 列表标题）                     | 主按钮                                        | 次按钮 / chip                 | 图标按钮            | 输入框 / Listbox                                                   | 卡片                | Tab / Segmented        |
| ------------------ | ----------------------------------------------------- | ------------------------------------------- | --------------------------------------------- | ----------------------------- | ------------------- | ------------------------------------------------------------------ | ------------------- | ---------------------- |
| 默认               | `link` 色 + 下划线                                    | `label` 色无下划线                          | `accent` 底                                   | `fill` 底 + 1px 透明边        | 透明底 + 1px 透明边 | `surface-2` + 1px `separator`                                      | `surface`           | `label-2`              |
| hover（指针）      | 下划线加粗 2px                                        | `label` + `fill` 底（导航）/ 下划线（标题） | 加深 8%                                       | `fill-strong`                 | `fill` 底           | 边 `label-3`                                                       | 上浮 2px + `elev-1` | `label`                |
| focus-visible      | 焦点环                                                | 焦点环                                      | 焦点环                                        | 焦点环                        | 焦点环              | 焦点环 + 边 `accent`                                               | 卡片焦点环          | 焦点环                 |
| pressed            | 颜色加深                                              | `fill-strong` 底                            | `scale(.98)` + 加深 14%                       | `scale(.98)`                  | `scale(.92)`        | —                                                                  | `scale(.98)`        | —                      |
| selected / current | —                                                     | `accent` 字 + 600（`aria-current`）         | —                                             | `accent` 12% 底 + `accent` 字 | `accent` 字         | 选中项 ✓                                                           | —                   | 白底滑块 + `label` 600 |
| visited            | 列表 / 搜索结果标题变 `label-2`（仅文章、视频、论坛） | 同左                                        | —                                             | —                             | —                   | —                                                                  | —                   | —                      |
| disabled           | `label-3` 无下划线                                    | 同左                                        | `opacity .4` + `not-allowed`                  | 同左                          | 同左                | `fill` 底 + `label-3`                                              | 不渲染为可点        | `label-3`              |
| loading            | —                                                     | —                                           | 16px spinner，宽度不变，`aria-busy`           | 同左                          | spinner 替换图标    | 右侧 spinner                                                       | 骨架                | —                      |
| error              | —                                                     | —                                           | —                                             | —                             | —                   | 边 `danger` + 字段下错误文案（`aria-describedby`、`aria-invalid`） | 内联错误条          | —                      |
| 强制色             | `LinkText`                                            | `LinkText`                                  | `ButtonText` on `ButtonFace` + `ButtonBorder` | 同左                          | 同左                | `Field` / `FieldText`                                              | 1px `CanvasText` 边 | 选中 `Highlight`       |

- **禁用主按钮不作为页面唯一主操作**：功能未上线时换成另一个可用操作（如「上线时通知我」），平台信息写成 meta 文字。
- `::selection { background: color-mix(in srgb, var(--c-accent) 24%, transparent); color: inherit; }`；`::placeholder { color: var(--c-label-3); opacity: 1; }`；`caret-color: var(--c-accent)`。
- 原生 `title` 只用于缩写；需要提示时用 `Tooltip` 组件（hover 300ms 延迟 / focus 立即 / 触屏长按，`role="tooltip"` + `aria-describedby`，最大宽 240、`caption` 字号、`elev-2`）。
- 弹层（菜单、搜索面板、对话框、Toast）都有进入**和退出**动画：进入 `--dur-fast` `--ease-out`，退出 `--dur-fast` `--ease-in`；减少动态时只做淡入淡出。

## 17. UI 图标规范

- **图标集**：Lucide 子集（ISC 许可）按需内联为 `Icon.astro` 的路径表；24 网格、`stroke-width: 1.75`、`stroke-linecap/linejoin: round`、`fill: none`、`currentColor`。
- **填充变体**只用于：TabBar 当前项、点赞 / 收藏已选中、状态徽标里的实心点。同一组控件里不能线性与填充混用（选中态除外）。
- **尺寸**：16（行内 / 胶囊内）、20（按钮内、列表行）、24（图标按钮、TabBar）；图标按钮命中区 ≥ 44（移动）/ 36（桌面工具栏）。
- **光学对齐**：与文字同行时 `vertical-align: -0.125em`（16px）或 flex 居中；chevron / arrow 类在按钮末尾时与文字间距 4px；播放三角向右偏移 1px。
- **最低清单**（必须存在，禁止用字符代替）：chevron-left/right/down、arrow-right、arrow-up-right（外链）、download、external-link、search、x（关闭）、check、more-horizontal（⋯）、filter、sort、copy、share、play、pause、bell、bookmark、heart、message、user、settings、sun / moon / monitor（主题）、globe（语言）、alert-circle、info、check-circle、loader（spinner）。
- **禁止**：「→ ← › ‹ » ✓ ✕ ×」等字符当图标；emoji 当 UI 图标；同一视图出现两套图标风格。
- **品牌图标**（GitHub、YouTube 等）用官方填充字标，尺寸同 UI 图标，不与 Lucide 混在同一按钮组里时可例外。
- **验收**：Q18 扫描 DOM 内所有 SVG：viewBox 必须 `0 0 24 24`，描边宽 1.75（或标记 `data-icon-variant="filled"`），渲染尺寸 ∈ {16, 20, 24}；文本节点中 `[→←›‹»✓✕×]` 出现在按钮 / 链接末尾即失败。

## 18. 文案风格指南（Microcopy）

### 18.1 语气

- **陈述事实，不做辩白**。诚信原则（不伪造评分 / 下载 / 用户数）只在「关于」与「编辑规范」各写一次；其他页面靠数据本身体现（版本号、相对时间、来源链接）。
- **禁用词表（CI 检查，可见文本中出现即失败）**：不伪造、不造假、不刷、真实计数、真实下载、如实标注、非真实截图、本站暂无足够、不做热度、测试环境（作者测试环境）——后者改为「已测试：Chrome 129 · Windows 11」这样的具体信息。
- 空状态说「接下来能做什么」，不解释为什么没有（「还没有评价 · 写第一条」✅；「评分只来自真实用户，本站不预置任何评分」❌）。
- 「即将推出」只出现在状态徽章里，不做按钮文字。

### 18.2 CTA 动词表

| 场景           | 中文                           | English    |
| -------------- | ------------------------------ | ---------- |
| 自研应用已发布 | 获取 / 打开                    | Get / Open |
| 第三方工具官网 | 访问官网                       | Visit site |
| 命令行工具     | 安装                           | Install    |
| 游戏 / Demo    | 试玩                           | Play       |
| 视频           | 观看                           | Watch      |
| 未发布         | 上线时通知我                   | Notify me  |
| 订阅           | 订阅更新                       | Subscribe  |
| 查看全部       | 查看全部（不带数字和箭头字符） | See all    |

- 按钮文字 ≤ 6 个汉字 / 2 个英文词；英文按钮与标题用 **Title Case**（Get Started、See All），正文与说明用 Sentence case。
- 一个按钮只做一件事（「上线通知 RSS 订阅」❌ → 「上线时通知我」+ 次级链接「RSS」）。

### 18.3 术语表（栏目名 = 导航名 = 页面 H1 = 页脚名 = 面包屑）

| 概念     | 中文           | English      | 不用                                                                            |
| -------- | -------------- | ------------ | ------------------------------------------------------------------------------- |
| 应用栏目 | 应用           | Apps         | 应用商店、应用目录（H1 可以是「应用」，副标题说明「AZ Studio 自研与精选应用」） |
| 自研应用 | AZ Studio 出品 | By AZ Studio | 自研应用 / 本站作者                                                             |
| 站点作者 | 作者           | Author       | 站长、本站作者                                                                  |
| AI 工具  | AI 工具        | AI Tools     | AI 工具库                                                                       |
| 作品     | 作品           | Works        | 作品与视频（视频是独立栏目）                                                    |
| 论坛     | 论坛           | Forum        | 社区（社区 = 论坛 + 留言板的统称，只在页脚分组用）                              |

### 18.4 标点、数字、日期

- 中文引号用「」，嵌套『』；英文页用 “ ”。中文正文不用半角 `, . ; :`；连接两段中文用「，」「。」或「 · 」，不用「. 」。
- 中英 / 数字之间半角空格（由 T9.10 的 `text-autospace: normal` 兜底，内容里仍手写空格；DOM 拼接处在模板加空格）。
- 数字：`Intl.NumberFormat`；中文 ≥ 1 万用「1.2 万」，英文 ≥ 1000 用「1.2K」；数字与单位之间空格（「30 个」「2 MB」「12 分钟」）。
- 日期：列表与卡片用相对时间（< 7 天「3 天前」、< 1 年「3 个月前」、≥ 1 年显示年月）；详情页与信息表用完整日期 —— 中文「2026年7月19日」、英文「Jul 19, 2026」；`<time datetime="2026-07-19">`。不再在可见文本里使用 ISO `2026-07-19`。
- 英文页面不得出现未翻译中文（例外：作品原名，需配英文说明）；未翻译文章不进 `/en/` 首页。

## 19. 图片与 OG 规范

### 19.1 OG / 社交卡片

- 尺寸 **1200×630**（1.91:1），PNG ≤ 300 KB；安全区四周 60px（社交平台裁切）；构建期用 `@resvg/resvg-js` 从 SVG 模板生成（`src/pages/og/*`）。
- 统一视觉：中性底（浅 `#F5F5F7` / 深 `#1C1C1E` 二选一，按页面类型固定）+ 左上 Logo 40 + 底部 8px 品牌绿条；标题 56/700（≤ 2 行）、副标题 30/400 `label-2`（1 行）。不使用与品牌无关的强调色（文章 OG 现在的蓝色改为品牌绿）。
- 模板：

| 页面类型           | 内容                                                        |
| ------------------ | ----------------------------------------------------------- |
| 应用 / AI 工具详情 | 图标 160（squircle + 规范化）+ 名称 + tagline + 分类 · 价格 |
| 游戏详情           | 封面 16:9 占左 60% + 名称 + 类型                            |
| 视频详情           | 缩略图 + 标题（≤ 2 行）+ 频道 · 时长                        |
| 文章               | 标题 + 分类 + 阅读时长                                      |
| 论坛帖             | 标题 + 分类 + 回复数（静态种子帖；数据库帖用论坛默认图）    |
| 栏目页 / 首页      | 栏目名 + 一句话 + 4 个代表图标                              |
| `/en/`             | 同模板英文文案                                              |

- 不在 OG 图里写辩白文案（「不伪造…」）。数字与量词不拆行（「30 行」作为一个不可断单元）。
- `twitter:card = summary_large_image`；`og:image:alt` 必填（= 标题）；`og:type`：文章 `article`，其余 `website`。
- **meta description**：中文 50–80 字；英文 110–160 字符；每页唯一；不以站名开头。

### 19.2 站点图标与 PWA

- `favicon.svg`（文字转路径，不依赖系统字体；颜色用 hex）、`favicon.ico`（16/32/48）、`apple-touch-icon.png` 180（不透明底）、manifest 192 / 512 / maskable 512（安全区 80%）。
- manifest：`theme_color` 浅色 + HTML 里深浅两条 `theme-color` meta（已有）；`screenshots`（窄 1080×1920、宽 1920×1080 各 1）；`shortcuts`（应用 / AI 工具 / 搜索 / 论坛，各带 96 图标）。

### 19.3 内容图片

- 首屏图片 `loading="eager"`，首屏第一张关键图 `fetchpriority="high"`；首屏以下 `loading="lazy" decoding="async"`。
- 所有图片容器自带垫板底色（`--icon-plate` / `fill`）和固定 `aspect-ratio`，图片加载前与失败时都显示垫板；`img { color: transparent }` 隐藏裂图 alt 文本；`error` 事件换 Monogram / 品牌占位。
- alt：名称已在旁边可见时 `alt=""`；独立出现时 alt = 名称（不加「图标」「图片」等字）；截图 alt 描述画面内容。
- 深色模式：照片 / 截图不做滤镜；白底 logo 走 §6.3 垫板；插画类封面在深色下可降 6% 亮度（`filter: brightness(.94)`），仅限插画。
- 没有真实截图的应用不显示「截图」区；概念图只能放在「设计方向」小节，宽 ≤ 正文宽、不进货架。

## 20. 邮件模板规范

- **结构**：600px 居中单列表格布局 + 全部内联样式（邮件客户端不支持 `<style>` 的情况按 Gmail / Outlook 最低集处理）；外层背景 `#F5F5F7`，内容卡白底 12px 圆角（Outlook 无圆角可接受）。
- **区块顺序**：preheader（隐藏，≤ 90 字，概括邮件）→ Logo 头（32 高，PNG + alt「AZ Studio」）→ 标题（22/700）→ 正文（16/1.6，`#1D1D1F`）→ 主按钮（bulletproof：`<table>` + `<a>` 背景 `#1F7A52`、白字 16/600、44 高、12 圆角）→ 备用链接（「按钮无法点击？复制此链接：…」13 `#6E6E73`）→ 分隔线 → 页脚（为什么收到这封邮件、退订链接、站点地址，12 `#6E6E73`）。
- **字体**：`-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`。
- **深色模式**：`<meta name="color-scheme" content="light dark">` + `@media (prefers-color-scheme: dark)` 覆盖（支持的客户端），Logo 用带白描边版本，避免深色下消失。
- **头**：`List-Unsubscribe: <https://…>, <mailto:…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`；发件人名「AZ Studio」；主题 ≤ 30 字，不用感叹号。
- **纯文本版**与 HTML 内容一致（已有）。
- **语言**：中英两套各一份模板，不混排。
- **验收**：模板快照（浅 / 深 / 360 宽）进视觉回归；头字段单测；Gmail（网页 + 安卓）、Outlook（Windows 新版）、Apple Mail（iOS）人工各看一次。

## 21. 视口与系统模式

- **视口档**：320（最小支持）/ 390 / 768 / 1024 / 1440 / 1920 / 2560；以及横屏 844×390、740×360。320 必须无溢出、无拉丁单词内断行。
- **宽屏档 ≥ 1600**：`--container: 1360px`；网格列数在 1200 档基础上 +1；货架左对齐容器、右侧出血到视口边缘。字阶不放大。
- **正文行长**：中文 30–45 字 / 行（`--reading-max: 40em` ≈ 680–720px @17px），英文 45–75 字符；所有长文本（文章、视频导读、隐私、关于、详情页介绍）都受此约束。
- **断词**：全局 `overflow-wrap: break-word`；`anywhere` 只用于 `.prose a`, `code`, 用户生成内容容器、URL 字段；Logo、按钮、统计数值、标签 `white-space: nowrap`。
- **小高度**（`max-height: 480px`）：TabBar 只显示图标（40 高），顶部导航向下滚动时隐藏、向上滚动出现。
- **强制色**：所有成形控件有 `border: 1px solid transparent`；`@media (forced-colors: active)` 中图标 `fill/stroke: CanvasText`、选中 `Highlight`、品牌 Logo 底块 `forced-color-adjust: none`；不能依赖背景色或阴影表达状态。
- **减少动态**：保持现状（位移 / 缩放为 0、`scroll-behavior: auto`），新增的退出动画同样遵守。
- **文字放大 200%**：字号继续用 rem；卡片使用最小高度而非固定高度包住文字；截断数不超过基线 + 5。
- **打印**：`@media print` 隐藏导航 / TabBar / 页脚 / 讨论 / 广告 / 货架按钮 / 主题与语言按钮；正文 11pt 黑字白底、行高 1.6；`a[href^="http"]::after { content: " (" attr(href) ")" }`（正文内）；截图纵向排列；`h2, h3 { break-after: avoid }`、`figure, pre, table { break-inside: avoid }`；页眉一行「AZ Studio · 标题 · URL」。

## 22. 中文排版细则

### 22.1 字体栈

```css
--font-sans:
  -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
  'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif;
--font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, 'Noto Sans Mono CJK SC', monospace;
```

- 系统字体，不引入网络字体（无 FOUT，已验证 `@font-face` 0）。
- Windows 上拉丁（Segoe UI，600 有真字重）与中文（雅黑，600 → 700）混排会粗细不一：标题优先 600，评审在 Windows 真机进行（T9.19）。

### 22.2 标点

- `text-spacing-trim: trim-start`（标题行首全角标点去半格）+ `text-autospace: normal`（Chrome 140+ 中英自动间距，内容里的手写空格保留以兼容旧浏览器）。
- 标题不以句中逗号分隔两个短语（用换行或「·」）。
- 数字 + 量词、品牌名、版本号作为不可断单元（`<span class="nobr">`，`white-space: nowrap`）。
- 禁则依赖浏览器默认 `line-break: auto`（第二轮实测仅 1 处英文标点落行首），不强制 `strict`。

### 22.3 强调

- 中文不用斜体（无真斜体，浏览器会做伪斜体）：`.prose em:lang(zh) { font-style: normal; font-weight: 600; }`，或 `text-emphasis: filled dot; text-emphasis-position: under right`（仅用于短词）。

### 22.4 正文元素（`.prose`，文章 / 论坛 / 留言 / 回复共用）

| 元素             | 规则                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| h2               | title-2（20/600），上 2em 下 .6em                                                                                                                                                                           |
| h3               | title-3（17/600），上 1.6em 下 .4em（必须 ≥ 正文字号）                                                                                                                                                      |
| p / li           | body 17 / 1.8，段距 1em                                                                                                                                                                                     |
| 行内 `code`      | `.9em` mono，`fill` 底，`2px 6px` 内边距，`radius-xs`                                                                                                                                                       |
| `pre`            | 14 mono / 1.6，`surface-2` 底，`radius-md`，16 内边距，**横向滚动不折行**（`overflow-x: auto; tabindex="0"; aria-label="代码"`），Shiki 构建期高亮（主题色由 token 生成，深浅各一）；右上角「复制」图标按钮 |
| `blockquote`     | 左 3px `separator-strong` 竖线 + 16 内边距 + `label-2`                                                                                                                                                      |
| `table`          | 外包 `.table-wrap { overflow-x: auto }`；表头 `fill` 底 13/600；行线 1px `separator`；单元格 `10px 12px`；数字列右对齐 + `tabular-nums`；第一列可吸附                                                       |
| `kbd`            | 12 mono，1px `separator-strong` 边 + 底部 2px 阴影，`radius-xs`，`1px 6px`                                                                                                                                  |
| `hr`             | 1px `separator`，上下 2em                                                                                                                                                                                   |
| `img` / `figure` | 宽 ≤ 100%，`radius-md`；`figcaption` caption 13 `label-2` 居中，上 8px                                                                                                                                      |
| 脚注             | `sup { line-height: 0 }`；脚注区上方 1px 分隔线 + 「注释」小标题，14 / `label-2`；回跳链接用 Lucide `corner-up-left` 图标                                                                                   |
| 链接             | 下划线（已有），`text-underline-offset: .2em`                                                                                                                                                               |
| 任务列表         | 自定义复选框 18px，与文字顶对齐                                                                                                                                                                             |
