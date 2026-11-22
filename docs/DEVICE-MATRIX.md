# AZ Studio v2 · 设备 / 浏览器矩阵（T9.19）

> 日期：2026-10-26 · 分支 `v2/astro` · 方法：**Playwright 设备模拟**（视口 / DPR / 触摸 / UA），三引擎（Chromium / Firefox / WebKit）。
> **这不是真机测试**：我们没有物理设备，WebKit ≠ iOS Safari、Chromium ≠ Android Chrome；系统字体（微软雅黑 / 苹方 / Segoe UI）、
> GPU 合成、滚动惯性、地址栏伸缩、安全区、真实网络都模拟不到。§4 列出必须由人用真机确认的项。

## 1. 自动化矩阵（CI 阻断）

- 配置：[`playwright.devices.config.ts`](../playwright.devices.config.ts)，用例：[`tests/devices/matrix.spec.ts`](../tests/devices/matrix.spec.ts)
- CI：`devices` 任务（三引擎并行），产物 `device-matrix-<引擎>`（每格首屏截图 + `<引擎>.jsonl` 结果行，保留 14 天）
- 本地：`npm run build && npx playwright test -c playwright.devices.config.ts`（`PW_BROWSERS=webkit` 只跑一个引擎）
- 每格断言：横向溢出 0；≥ 900 顶栏导航可见 / < 900 底部 TabBar 可见；唯一 h1 且可见；详情页（应用 / AI 工具 / 游戏）主按钮在首屏；无未捕获脚本错误。
- 页面（9）：首页、应用列表、应用详情、AI 工具详情、游戏详情、文章详情、论坛、登录、英文首页。

## 2. 结果（8 设备档 × 3 引擎 × 9 页 = 216 格）

| 设备档           | 视口（CSS px） | Chromium | Firefox | WebKit |
| ---------------- | -------------- | -------- | ------- | ------ |
| iPhone SE        | 320 × 568 @2   | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| iPhone 15        | 393 × 659 @3   | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| Pixel 7          | 412 × 839 @2.6 | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| iPad 竖（gen 7） | 810 × 1080 @2  | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| iPad 横（gen 7） | 1080 × 810 @2  | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| 桌面 1024        | 1024 × 768     | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| 桌面 1440        | 1440 × 900     | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |
| 桌面 1920        | 1920 × 1080    | 9/9 ✅   | 9/9 ✅  | 9/9 ✅ |

本地（沙箱 arm64，Noto CJK）与 CI（ubuntu x64，fonts-noto-cjk）结果一致：**216 / 216 通过**。CI 运行号见 §5。

补充测量（不作阻断）：

- **页面高度差（Q16 参考）**：72 组（设备 × 页面）里 65 组三引擎高度差 ≤ 3%。超出的 7 组里 5 组是首页——首页首屏以下区块用了 `content-visibility: auto`（占位高 520px），各引擎在未渲染时按占位估高，不代表真实差异；另 2 组是 iPad 横屏论坛（Firefox 比 Chromium 短 6.5%，论坛列表在测试里请求被拦截、显示错误态，字体度量差放大）与 iPad 竖屏首页（4.3%）。
- **加载到 load 事件**（本地静态服务，无网络节流）：中位数 Chromium 1.6s / Firefox 0.8s / WebKit 1.9s，最差 WebKit 4.8s（首页，沙箱 CPU 争用）；性能结论以 Lighthouse 为准（见 DESIGN-AUDIT-3）。

## 3. 截图检查中发现的问题

| #   | 现象                                                                                                                                                      | 级别 | 处理                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| M1  | 390 宽键盘 Tab 时焦点元素滚到底部 TabBar 下面（WCAG 2.4.11 焦点不被遮挡）                                                                                 | P1   | **已修**：< 900 时 `html { scroll-padding-bottom: TabBar 高 + 安全区 + 16px }`；`tests/design/a11y.spec.ts` 覆盖 6 页 × 2 视口 |
| M2  | 「跳到正文」聚焦瞬间测得仍在视口外（CI 偶发）：减少动态下全局 `transition-duration: 0.01ms` 让 `top` 也走一次极短过渡，测量落在过渡起点；真实用户不受影响 | P2   | 测试改为等两帧再量；`.skip-link` 顺带改 `position: fixed`（页面已滚动时同样出现在视口顶部）                                    |
| M3  | iPhone SE（320 宽）顶栏「AZ Studio」折成两行（整词折行，不是单词内断开；Q5 不违规）                                                                       | P2   | 遗留：强制不折行会在「仅文字放大 200%」时溢出。等 T9.0 Logo 精修后考虑 320 宽只显示图形标                                      |

## 4. 仍需真机人工确认（站长 / 测试用户，结果记入 SIGNOFF.md）

> 每项在真机上截图，压缩后放 `docs/design-evidence/`（只放关键图）。打勾表示已看过且无 P0 / P1。

**iOS Safari（iPhone，iOS 17+）**

- [ ] 底部 TabBar 与 Home 指示条（安全区）不重叠；地址栏收起 / 展开时 TabBar 不跳动
- [ ] 顶栏毛玻璃（`backdrop-filter`）滚动时不闪烁、文字可读
- [ ] 货架横滑惯性自然、无纵向误触；整卡点击无蓝色高亮块
- [ ] 输入框聚焦不自动放大页面（字号 ≥ 16px）；软键盘弹出时发帖编辑器工具栏可见
- [ ] 深色模式跟随系统；切换外观后状态栏颜色（`theme-color`）正确
- [ ] VoiceOver：首页、应用详情、发帖页可按标题 / 地标导航，按钮名称正确

**Android Chrome（中端机，Android 12+）**

- [ ] 同上 TabBar / 手势导航条、货架滑动、点击反馈
- [ ] 系统字体放大（设置 → 字体大小最大）时卡片与导航不截断
- [ ] PWA「添加到主屏幕」图标（maskable）正常、离线页可打开

**iPad（竖 / 横）**

- [ ] 竖屏（810–834 宽）为 TabBar 布局、横屏（≥ 1080）为顶栏 + 「更多」；外接键盘 Tab 焦点环可见
- [ ] 分屏（Split View）窄宽度下无横向溢出

**Windows 11 Chrome / Edge（微软雅黑）**

- [ ] 100% 与 150% 缩放：标题字重（600 在雅黑上显示为 700）观感可接受（N-FONT-1）
- [ ] 货架无灰色原生滚动条；强制色（高对比主题四套）下焦点环 / 按钮边框可见

**macOS Safari / Chrome（苹方）**

- [ ] 字重与行高观感；Safari 下 `text-wrap: pretty` / `text-autospace` 回退正常

**邮件客户端（订阅确认邮件，T9.15）**

- [ ] Gmail（网页 + Android App）：Logo 头、按钮（bulletproof）、preheader、退订入口
- [ ] Outlook（网页或 Windows 桌面）：按钮不变形、深色模式反色可读
- [ ] iOS 邮件：深色模式 Logo 头切换、「退订」横幅出现（`List-Unsubscribe-Post`）

**性能 trace（T9.19 原要求，需真机 + DevTools）**

- [ ] 货架滚动、整页滚动、卡片 hover、导航毛玻璃：p95 帧 ≤ 20ms、无 > 50ms 长任务（无头沙箱没有 GPU，数据不可用）

## 5. CI 记录

见 PR #2 最新绿色运行的 `devices (chromium / firefox / webkit)` 任务（运行号写在 PLAN.md 的 PR D 落地注）。
