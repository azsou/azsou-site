# 第六轮收尾：桌面 Lighthouse `/ai/claude-code/` CLS 0.0289（2026-10-29）

## 失败

- CI push run 40729377703（#4 头 `b1eacf1`），lighthouse 任务「Lighthouse 桌面档（12 页，T9.21）」：
  `cumulative-layout-shift` 0.02890 > 0.02（门槛不变）。同一 SHA 的 PR run 40729397553 通过，#6 push 40729718621 的同页是 0。
- LHR 的 layout-shifts 只列出一个节点：`body > main#main > div.shell`，分数就是全部 0.0289；胶片帧在 375 ms 以后没有变化，
  位移发生在首帧（110 ms）到 FCP 之间。

## 本机复现（Lighthouse 12.8.2 desktop preset，`--save-assets` 保留 trace；修复前用 CI 的 dist 产物，修复后用本机同口径构建）

| 构建                      | 运行次数                                                  | CLS > 0.02              | 最大值 | 其余     |
| ------------------------- | --------------------------------------------------------- | ----------------------- | ------ | -------- |
| 修复前（CI 产物 b1eacf1） | 20                                                        | **2**（0.0357、0.0357） | 0.0357 | 0–0.0049 |
| 修复后（本提交）第 1 批   | 18 有效（另 2 次 Lighthouse 报 NO_NAVSTART，没有 CLS 值） | 0                       | 0.0049 | 0–0.0049 |
| 修复后（本提交）第 2 批   | 15                                                        | 0                       | 0.0049 | 0–0.0049 |

修复前命中的两次 trace 完全相同：一个 LayoutShift 事件，`frame_max_distance` = **54.8 px**，
受影响节点 `.shell` 旧 `[75, 85, 1200, 230]` → 新 `[68, 85, 1200, 855]`，顶栏 `nav.shell` `[75,0,…]` → `[68,0,…]`。

## 根因

1. 旧帧的 `.shell` 只有 230 px 高（面包屑 + 头部），新帧 x 从 75 变成 68：这一帧里页面变长、出现滚动条，整页横移 7 px。
   单独这一项只有约 0.004（就是上表 0.0049 那些，第四轮已记录的滚动条余量）。
2. 但 CLS 的距离取这一帧里**移动最多的那个元素**。把 HTML 截断在真实位置（JS 关闭、保留滚动条）逐个元素比对完整页面：
   截断在 `<div class="app-downloads detail-actions" …>` 之后（卡片里还没有按钮）时，`.detail-hero__actions` 只剩 32 px 内边距，
   位置 `935,202,320×32`；完整页面是 `928,147,320×178`——**上移 55 px**，和 trace 的 54.8 一致。
3. 原因是 ≥ 1200 时操作卡跨三行 `align-self: center`（`src/styles/detail.css`）：卡片内容还没到齐时它居中偏下，到齐后长高、回到顶部附近。
   整张卡在 HTML 里只有约 570 字节，Chromium 偶尔就在这里先画一帧（本机 2/20）。
4. 两件事落在同一帧：影响面积 ≈ 整个视口（横移的 .shell），距离 = 55 / 1350 → 0.029–0.036。

## 为什么不改成 `align-self: start`

那样最终布局会变：47 个详情页里有 42 个操作卡比左栏矮（本机 1350 宽实测），居中和顶对齐差 9–42 px，视觉基线要重做，而且是设计决定。

## 修复（最终布局与视觉基线不变）

- 详情页 `<head>` 里加 `<link rel="expect" href="#detail-hero-end" blocking="render">`（`Base.astro` 新属性 `renderBlockUntil`，
  只有 `ai/[slug]`、`apps/[slug]`、`games/[slug]` 三个使用 `DetailHero` 的页面传入）。
- `DetailHero` 的最后一个子元素是 `<span id="detail-hero-end" hidden>`。头部（含整张操作卡、链接行）解析完之前浏览器不画首帧，
  也就不会有「卡片半截居中」的那一帧。`hidden` 元素不参与网格布局；不支持 `rel=expect` 的浏览器（Firefox / Safari）忽略它，行为与之前一样。
- 门槛（≤ 0.02）、Lighthouse 配置、采样次数都没有改。FCP 没有变差（本机中位数修复前 559 ms，修复后 369 ms，两批都在同一台机器上跑）。

## 回归测试

`tests/built/detail-hero-render-block.test.ts`（build 之后由 `npm run test:ld` 运行）：每个构建出来的详情页（ai 30 / apps 8 / games 9，共 47 个）
head 里恰好一个 `rel=expect` 标签、body 里没有；标记 id 只有一个、是头部最后一个子元素、`hidden`；操作卡在标记之前。
