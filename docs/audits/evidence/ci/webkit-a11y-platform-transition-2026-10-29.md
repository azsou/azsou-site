# WebKit a11y 详情页首跑失败：首次推荐主按钮的颜色过渡（2026-10-29）

## 现象（CI，CLS 修复 3bcd33d / 54044d9 / 4cdfa27 之后的 6 次运行全部出现，重跑通过）

| 运行                                                                          | 任务                | 首跑失败                                                                        |
| ----------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| #4 push 40749920542                                                           | e2e (webkit, 2)     | webkit-iphone a11y /ai/chatgpt/、/ai/claude-code/                               |
| #4 PR 40749929526                                                             | e2e (webkit, 1 / 2) | webkit-iphone /ai/chatgpt/、/ai/claude-code/；webkit-desktop /apps/e2e-fixture/ |
| #5 push 40749922829                                                           | e2e (webkit, 1 / 2) | webkit-iphone /ai/claude-code/；webkit-desktop /apps/e2e-fixture/               |
| #5 PR 40749933998                                                             | —                   | 无                                                                              |
| #6 push 40749928914                                                           | e2e (webkit, 2)     | webkit-iphone /ai/claude-code/                                                  |
| #6 PR 40749939669                                                             | e2e (webkit, 2)     | webkit-iphone /ai/chatgpt/、/ai/claude-code/                                    |
| 修复 CLS 之前（#5 5dc22b4：push 40730344959、PR 40730353297）flaky 清单为空。 |

失败 trace（run 40749920542 playwright-report-webkit-2，axe finishRun 结果）：

- `a[href$="web/"] > span`（服务端默认主按钮「网页版」）前景 #8e6cd2 / 背景 #cabce7，对比度 2.26
- `.btn--primary > span`（脚本推荐的新主按钮）前景 #dcd2f1 / 背景 #8866cf，对比度 2.99
  两组都是「主按钮实心紫 ↔ 次按钮淡紫底」之间的中间色：axe 取色时两个按钮正在互换样式。

## 根因

- `src/scripts/apps/platform.ts` 按访客设备把推荐平台设为主按钮（toggle `btn--primary`）。`.btn` 有 160ms 的 background-color / color / box-shadow 过渡（components.css）。
- 换 class 发生在首帧之后时，两个按钮各播放一次过渡——访客看到一次闪烁，axe 恰好在这 160ms 里取色就报 color-contrast。
- WebKit 支持 `<link rel="expect" blocking="render">`（本机 Playwright WebKit：`relList.supports('expect') === true`），3bcd33d 让详情页首帧在头部解析完就画出（本机 FCP 约 600ms → 约 400ms），换 class 更稳定地落在首帧之后，所以 CLS 修复之后 WebKit 首跑开始出现；Chromium / Firefox 在首帧已画出时同样会播放过渡（下方回归测试修复前 8/8 失败），只是 CI 时序上没撞上 axe。
- 本机探针（WebKit，iPhone 13 设备，/ai/chatgpt/，记录下载区 transitionrun）：3 次里 2 次记录到 6 条过渡（web / ios × background-color、color、box-shadow），去掉 rel=expect 的副本 4/4 也记录到——过渡本身早就存在，是测试时序把它暴露出来。

## 修复（不加等待、不放宽 axe、不改门槛）

- 服务端给下载区带 `data-dl-init`；`[data-downloads][data-dl-init] .btn { transition: none; }`。
- `highlightPlatform` 换完 class 后 `void box.offsetWidth` 强制一次样式计算，再删掉 `data-dl-init`（try/finally，没有推荐结果时也会删），之后悬停 / 按压过渡照常。
- 最终样式、布局、视觉基线不变（截图在脚本之后，属性已删除）。

## 回归

`tests/e2e/detail-cta.spec.ts`「详情页：首次推荐主按钮不闪」：iPhone UA，页面一插入下载按钮就强制计算样式（相当于已画过一帧，不依赖时序），记录下载区 transitionrun；同时断言确实换过主按钮、`data-dl-init` 已移除、之后 transition 恢复。

- 修复前（本地候选 6e9d3af 构建）：chromium / firefox / webkit 桌面 + webkit-iphone × 2 页 = 8/8 失败（每条 6 条过渡）
- 修复后（本提交构建）：同 8 条全部通过；detail-cta / apps / ai 三个 spec 在 chromium-desktop、firefox-desktop、webkit-desktop、webkit-iphone 共 108/108 通过（含原有「按访客设备推荐下载按钮」用例）
