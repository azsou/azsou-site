# 设计质量测试规范（Design QA）

> 配套 [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)。目标：设计规范**由机器守门**，人工评审只看机器测不出的审美问题。
> 所有自动检查进 CI（`.github/workflows/ci.yml`），失败即阻断合并；「报告」级只出报告不阻断。

## 1. 门禁总览

| #   | 检查                                                                  | 工具                                                          | 级别                                      | 时机                  |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- | --------------------- |
| Q1  | Token lint：禁止 token 外的颜色 / 字号 / 圆角 / 阴影 / z-index / 时长 | stylelint + `stylelint-declaration-strict-value` + 自定义规则 | 阻断                                      | `npm run lint`        |
| Q2  | 视觉回归：页面 × 4 宽度 × 2 主题                                      | Playwright `toHaveScreenshot`                                 | 阻断                                      | e2e                   |
| Q3  | 内容长度：卡片字段字数上下限                                          | zod schema + `zhLength()`                                     | 阻断                                      | `astro check` / build |
| Q4  | 图标与图片：尺寸、底色、安全区、比例、体积                            | `scripts/design/check-assets.mjs`（sharp）                    | 阻断（缺图标）/ 报告（monogram）          | build 前              |
| Q5  | 溢出与截断：横向溢出、文字截断、单字断行                              | Playwright 浏览器内检测                                       | 阻断                                      | e2e                   |
| Q6  | 对比度                                                                | axe-core（已有）+ 自定义检测图标与垫板对比                    | 阻断                                      | e2e                   |
| Q7  | 触控目标                                                              | Playwright 测量                                               | 阻断（< 24px）/ 报告（< 44px 的主要控件） | e2e                   |
| Q8  | 排版一致性：每页字号档数、字重、组合数                                | Playwright 计算样式统计                                       | 阻断（超上限）                            | e2e                   |
| Q9  | 布局：网格列数符合断点表、卡片等高、货架整数张                        | Playwright                                                    | 阻断                                      | e2e                   |
| Q10 | 动效：悬停 CLS = 0、减少动态时无位移                                  | Playwright（已有 T6.9 用例扩展）                              | 阻断                                      | e2e                   |

## 2. 自动化细则

### 2.1 Token lint（Q1）

```jsonc
// .stylelintrc.json（节选）
{
  "plugins": ["stylelint-declaration-strict-value"],
  "rules": {
    "scale-unlimited/declaration-strict-value": [
      [
        "/color$/",
        "fill",
        "stroke",
        "font-size",
        "font-weight",
        "line-height",
        "letter-spacing",
        "border-radius",
        "box-shadow",
        "z-index",
        "transition-duration",
        "animation-duration",
      ],
      {
        "ignoreValues": ["inherit", "currentColor", "transparent", "none", "0", "100%", "50%", "unset"],
        "disableFix": true,
      },
    ],
    "declaration-no-important": true,
    "unit-allowed-list": ["px", "rem", "em", "%", "vh", "dvh", "vw", "fr", "ms", "s", "deg", "ch"],
    "media-feature-name-value-allowed-list": {
      "min-width": ["600px", "900px", "1200px"],
      "max-width": [],
    },
  },
}
```

- 例外只允许在 `src/styles/tokens.css`（生成文件）与 `tokens/*.json`。
- `.astro` 内 `<style>` 同样检查（`postcss-html`）。
- 自定义规则 `az/spacing-scale`：`margin / padding / gap / inset` 的 px 值必须在 `0 2 4 8 12 16 20 24 32 40 48 64 80` 内或用 `var(--space-*)`。
- 自定义规则 `az/font-weight`：只允许 400 / 600 / 700。

### 2.2 视觉回归（Q2）

- 页面清单 `tests/visual/pages.ts`：每种页面类型 1 个代表（与 DESIGN-AUDIT §1 的 51 个一致），加 `/_kit/` 组件目录页（每种卡片 × 最短 / 典型 / 最长内容 × 有图 / 缺图）。
- 矩阵：宽度 1440 / 1024 / 768 / 390 × `colorScheme` light / dark；Chromium 为主（WebKit 只跑 390 + 1440 浅色）。
- 稳定化：`reducedMotion: 'reduce'`；`page.clock.setFixedTime('2026-10-25T12:00:00+08:00')`；等待 `document.fonts.ready` 与所有 `img.complete`；遮罩动态区域（评分 / 下载计数 / 相对时间：`mask: [locator('[data-dynamic]')]`）；`animations: 'disabled'`。
- 阈值：`maxDiffPixelRatio: 0.002`，`threshold: 0.15`。
- 基线在 CI 同款 Docker（`mcr.microsoft.com/playwright:v1.64.1-noble` + `fonts-noto-cjk`）中生成，**不在本机生成**，避免字体差异；更新基线用 `npm run test:visual -- --update-snapshots` 并在 PR 里附对比图。
- 另跑一组 **Windows 字体模拟**：`page.addStyleTag` 把 `--font-sans` 换成只有 400/700 两档的 CJK 字体（Noto Sans SC 400/700 子集），确认层级在两档字重下仍清楚（截图人工审一次，之后入基线）。

### 2.3 内容长度（Q3）

```ts
// src/lib/zh-length.ts
export const zhLength = (s: string) =>
  [...s].reduce((n, ch) => n + (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.5), 0);
// content.config.ts
const zh = (min: number, max: number) =>
  z.string().refine((s) => zhLength(s) >= min && zhLength(s) <= max, { message: `字数需在 ${min}–${max}（汉字计 1，拉丁计 0.5）` });
tagline: zh(6, 16), summary: zh(32, 56), title: zh(1, 14)
```

- 上下限与 DESIGN-SYSTEM §10 表一致；`tests/unit/content-length.test.ts` 额外输出每个字段的 p50 / max 报告。
- CMS 字段 `pattern` 与 hint 由同一常量生成（`tests/unit/cms.test.ts` 已有一致性测试，扩展到字数）。
- 中英混排检查（报告级）：正文 / 标题里「汉字紧挨拉丁字母或数字」与「全角标点前后有空格」列出位置。

### 2.4 图标与图片（Q4）

`scripts/design/check-assets.mjs`（sharp）对每个 `icon.src` / `cover` / `thumbnail`：

| 检查          | 规则                                                                                                        | 失败级别                         |
| ------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 尺寸          | 图标源 ≥ 512×512 且正方形；封面 ≥ 规定最小宽、比例误差 ≤ 1%                                                 | 阻断                             |
| 预圆角 / 阴影 | 四角 8×8 区域 alpha < 250 或与边缘色差 > 阈值 → 判为自带圆角                                                | 阻断                             |
| 底色分类      | 输出 `colored / light / transparent / dark-glyph`，写入构建清单 `icon-manifest.json`，组件据此加垫板 / 描边 | —                                |
| 安全区        | 去底后主体外接框 / 边长 ∈ [0.68, 0.76]（插画型 `fullBleed: true` 例外）                                     | 阻断（生成的规范化图不达标时）   |
| 深色可辨识    | `dark-glyph` 在深色模式下主体与底色 ΔL* < 15 且无 `@dark` 变体                                              | 阻断                             |
| 体积          | 输出 AVIF/WebP：图标 ×2 ≤ 12 KB、封面 400w ≤ 120 KB                                                         | 报告                             |
| 缺失          | 游戏 / 自研应用无图标或封面                                                                                 | 阻断；第三方使用 monogram → 报告 |

### 2.5 溢出与截断（Q5）

浏览器内脚本（所有页面 × 4 宽度）：

```js
// 1) 页面横向溢出
expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
// 2) 单行省略号是否真的发生截断（标题、tagline、meta 不允许）
const cut = await page.$$eval('[data-trunc="forbid"]', (els) =>
  els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
);
expect(cut).toEqual([]);
// 3) 2 行 clamp 的简介：允许，但记录比例（> 20% 的卡片被截断 → 失败，说明内容超规格）
// 4) 单字断行：导航、按钮、chip、表头里任何元素高度 > 1 行且每行只有 1–2 个字 → 失败
// 5) 货架：每屏可见张数 = 整数 + peek（|visible − round(visible)| 在 peek/卡宽 ± 0.05 内）
```

组件给不允许截断的文字加 `data-trunc="forbid"`（标题、tagline、meta、按钮、导航）。

### 2.6 对比度（Q6）

- 现有 axe（wcag2a/aa/21a/21aa）深浅两主题全页面继续保留。
- 追加：图标与其背后背景（卡片）的对比：取图标边缘 2px 平均色与卡片背景计算 ΔE，< 6 且无描边 → 失败（防止白图标贴白卡）。
- 渐变封面上的文字：对封面区域截图取文字后方最亮像素计算对比 ≥ 4.5:1。

### 2.7 触控目标（Q7）

- 所有 `a, button, input, select, textarea, [role=button], summary, label>input[type=checkbox]` 的可点击区域（含 `::after` 撑满时取父卡片）：非行内元素 < 24×24 → 失败（WCAG 2.2 2.5.8）。
- 主要控件（主按钮、导航、TabBar、搜索框、货架按钮）< 44px 高 → 失败（HIG）。
- 相邻目标间距：两个 < 44px 的目标中心距 < 24px → 失败。

### 2.8 排版一致性（Q8）

每页统计可见文字节点的计算样式：

| 指标           | 上限                             |
| -------------- | -------------------------------- |
| 不同字号       | 7                                |
| 不同字重       | 3（400 / 600 / 700）             |
| 字号×字重组合  | 9                                |
| 不同字距       | 3                                |
| 最小字号       | 12px                             |
| 非整数 px 字号 | 0（hero display 例外）           |
| 中文正文行高   | 1.6–1.8（`body` / `body-sm` 档） |

### 2.9 布局（Q9）

- 每个 `[data-grid="row|tile|media|feature|category"]` 在 4 个宽度下的列数 = DESIGN-SYSTEM §8 表；不等则失败。
- 同一网格内卡片高度差 ≤ 1px（`grid-auto-rows: 1fr`）。
- 区块间距：相邻 `section` 的间距 ∈ {48, 64}；区块标题到内容 = 16。

### 2.10 动效（Q10）

- 扩展现有 T6.9 用例：对每种卡片 hover / focus / press，PerformanceObserver `layout-shift` 总和 = 0；兄弟元素位移 = 0。
- `reducedMotion: 'reduce'` 下 hover 后 `transform` 计算值为 `none`。
- 所有 `transition-duration` ∈ {80, 160, 240, 360}ms。

## 3. 人工评审清单（每个 P9 任务验收 + 上线前全站一次）

在 1440 / 768 / 390 × 浅 / 深 下逐页过一遍（参考 `contact-*.png` 改版前对照）：

**整体**

- [ ] 第一眼能说出页面最重要的一件事；每屏只有一个主按钮
- [ ] 同类元素看起来是「一家人」：图标大小、圆角、阴影、卡片高度一致
- [ ] 没有任何文字被意外截断、没有单字成行、没有孤字标点（「，」「。」不在行首）
- [ ] 留白有节奏：区块间距一致、卡片内边距一致，没有大片无意义空白
- [ ] 深色模式没有刺眼的白块（白底图标已垫板 / 描边）

**图标与图片**

- [ ] 同一行图标视觉大小一致（眯眼看，没有忽大忽小）
- [ ] 没有文字兜底图标出现在首页、列表首屏
- [ ] 缩略图比例统一、无拉伸、无模糊（2x 屏）

**文字**

- [ ] 标题 1 行、tagline 1 行、简介 2 行内说完
- [ ] 中英之间有空格、全角标点使用正确、数字与单位之间规范（「30 个」「2 MB」）
- [ ] 日期不显得过期（相对时间 / 版本号）

**交互**

- [ ] hover / focus / pressed / disabled / loading 五态都有且一致
- [ ] 键盘 Tab 顺序合理、焦点环始终可见
- [ ] 货架：无原生滚动条、边缘有渐隐提示、按钮到头禁用、触屏可滑

**后台 / CMS**

- [ ] 后台不显示前台导航与页脚；表格一行一个高度、操作在「⋯」里
- [ ] 表单错误在字段下方、字数计数可见、危险操作有二次确认
- [ ] CMS 预览与线上卡片一致、字数超限有提示

**跨平台**

- [ ] Windows Chrome（雅黑）下层级清楚、不「全站发粗」
- [ ] iPad 竖屏 768、安卓 360 无溢出

## 4. 运行方式（P9 落地后）

```bash
npm run lint            # Q1（stylelint + eslint + prettier）
npm run check:assets    # Q4
npm run test:unit       # Q3（字数）
npm run test:visual     # Q2（视觉回归，Docker 内）
npm run test:design     # Q5–Q10（tests/design/*.spec.ts）
```

审计脚本原型（本次审计用）：`.design-audit/audit.spec.ts`（不进仓库）—— Q5 / Q7 / Q8 / Q9 的测量逻辑可直接迁移到 `tests/design/`。
