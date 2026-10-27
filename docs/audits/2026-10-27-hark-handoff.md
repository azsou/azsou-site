# AZ Studio 商业交付审计与 Hark 执行交接

先修可用性和数据安全，再打磨视觉。本交接包含 64 项任务：14 项 P0、46 项 P1、4 项 P2。
P0 包含发布前置验证和门禁，不等于已经证实的安全漏洞数量。所有修复及修复后验收目前均未执行。

本 PR 只新增交接文档，不包含业务代码修复，不代表商业交付已验收，也不启动 Hark。
站长把本 PR 交给 Hark 后，由 Hark 分批提交实现、测试与证据，站长负责范围、视觉基线和发布签字。

## 开工入口与版本边界

- 配套文件：[完整测试方案与 95 项用例](2026-10-27-test-plan.md)。两份文档包含执行所需清单，不依赖能否打开聊天附件。
- 原始要求及审计起点：[PR #2 指定评论][PR]。
- 审计日期：2026-10-27，时区 Asia/Shanghai。
- 固定源码基线：`2794ccb62e016ee9cb2dbc419448427844c73485`，分支 `v2/astro`。
- 此交接 PR 的目标分支必须是 `v2/astro`，不是 `main`，避免把原 PR 的全部业务改动混入文档交接。
- 预览入口：<https://azsou-site-git-v2-astro-azsous-projects.vercel.app>，这是可变分支别名，不是版本证明。
- 开工先核对最新 head、部署 commit、数据库迁移与功能开关。发生变化时记录差异并重现，不混用旧截图。
- 后续实现从核对后的 `v2/astro` 新建小分支，各批单独 PR。不得直接向 `main` 推送或自动合并。

## 已确认的问题与证据边界

### 第一优先级：真实后台不可正常读取，设置还有误覆盖风险

已登录管理员预览中，概览、内容、用户、举报、留言、友链、订阅、审计共 8 个模块显示
“网络或服务暂时不可用，请检查网络后重试”；内容页重试仍失败，详见 A15/T091。
登录识别和 HTML 壳可见不代表数据库正常。尚未取得足以确定根因的 Network/服务端证据，不能先断言迁移未跑、CORS 或 RLS 就是原因。

`src/scripts/admin/settings.ts` 的读取异常分支会 `fill(mergeSettings([]))`，保存未以成功加载真实设置为前提。
因此存在读取失败、写入恢复后以默认值覆盖真实配置的风险，详见 A16/T092/T095。
审计没有点击保存，也没有证明实际发生过覆盖。

### 其他应优先复现的项

- A01：`setPublished()` 直接 PATCH 与 `mod_set_workflow()` 分离，公开标志和工作流存在漂移风险。
- A02：定时发布未核对目标 UPDATE 行数，已删除目标可能仍计成功。源码已有 `FOR UPDATE SKIP LOCKED`，不是完全没有并发保护。
- A03：无人值守调度和生产迁移状态仍须核实；不能把浏览器打开页面触发 tick 当作生产调度闭环。
- A17：官方内容页只列应用 8、游戏 9、文章 15、作品 12，共 44 项；遗漏工具 30 和视频 24。
  固定基线六类共 98 项，后续须按最新内容清单重新计算，不能永久写死 98。
- A18：390×844 权限页能力列被挤成每行 1 至 2 字；用户详情缺参态头部有大块空白，手机搜索按钮名称需补功能语义。
- F10：`/search/?q=Claude` 选择“视频 6”后 URL 不保存 type，刷新回“全部 18”。结果数只是本次版本观察，不是固定断言。
- D01/F01/F09：手机主导航缺 AI、视频、作品的直接发现入口；AI 筛选区和论坛分类区挤占首屏。
  这些栏目仍可由页脚、正文或搜索到达，不是页面不存在。
- F05：EMBERDEEP 正文承诺浏览器 Demo，实际仅有上线通知 CTA；补真实入口或改成准确的待发布说明。

### 本次实际覆盖，不夸大为全站验收

- 保存了 35 张真实浏览器截图：16 张前台截图（15 个不同 URL）、17 张已登录后台截图、2 张门禁截图。
- 检查了 12 个后台主模块及用户详情缺参态。读取失败阻止了有数据业务状态的完整验证。
- 手机截图是 390×844 视口模拟，主要桌面尺寸为 1440×900，不是 iPhone 或 Android 真机验收。
- 源码清点有 108 条路由、模板、接口和派生端点记录，对应 106 个唯一源文件路径；这不是 108 个页面。
- apps 8、tools 30、articles 15、videos 24、games 9、works 12；另有 78 个 `/go/` 平台组合、120 个 tag 展开项。
  以上是固定源码基线清点，真实构建、动态数据库实例和 sitemap 的最终分母仍须 B02 对账。
- 未完成全部 URL/状态/主题的整页截图，未执行业务写入、生产迁移、全套 npm/Playwright/数据库/Lighthouse 命令或真机验收。
- 原 head 的既有 CI/checks 为成功记录，但本轮没有重跑，不构成本交接或未来修复版本的通过证据。
- 原始截图与审计附件保存在[审计记录][LIVE]。文件名见测试方案；访问不到时按重现说明重新采集，不阻塞阅读任务清单。

保留现有能力，不推倒重来：已有三引擎 CI、RLS/RPC、视觉 diff、reduce motion、图标兜底、安全头。
0017 已有 `tests/db/crm.test.ts` 和 `tests/e2e/admin.spec.ts` 的专项测试，缺的是负面、并发和一致性边界，不是“完全没有测试”。

## 产品和视觉合同

目标是 macOS/iOS 式清晰层级、紧凑而可触达的操作、统一精美图标和即时反馈，不是全站堆玻璃、缩小字号或复制苹果专有资产。
Windows/Android、键盘、触屏、读屏与高对比同样属于交付范围。

- 首轮先收敛共享壳、间距/字号/颜色/圆角/动效令牌、图标、主 CTA、列表和空错态，再向所有模板扩散。
- 设计预览至少包含：首页、AI 列表、应用详情、文章、论坛、后台数据表、手机权限页；浅深色、桌面手机成组审阅。
- 紧凑视觉与命中区分离：项目主要触控目标为 44×44 CSS px；不把它错误描述成 WCAG AA 的统一最低值。
- 系统字体栈优先，不未经许可打包 Apple 字体或移植 SF Symbols。品牌素材有出处与许可。
- 不伪造评分、下载量、真实产品截图、真机验证或商用完成度。概念图和待发布产品明确标注。
- 当前范围是应用/AI 工具目录、个人站、社区及后台，不新增购物车、支付、退款系统。
- 官方内容目前明确 Git-only、无 CMS 写入。I06/T051 仅在站长确认 CMS 已启用或纳入范围后执行，否则记录不适用及依据。

## 执行批次与验收门禁

任务 ID 保持不变，批次内按依赖执行，不按文档出现顺序机械推进。

- 批次 0：B01/B02/B03/B05。锁版本、合成角色和隔离环境，建立路由、测试、截图账本。
  B02 的首版分母先交付，完整截图随各批补齐，不能等全部截图完成才处理 P0。
- 批次 1：A15、A16。先定位八模块读取失败；设置失败禁止保存的保护可以用隔离故障注入先开发，最终真实回归依赖 A15。
  首个实现 PR 必须带 T091/T092/T095 的证据，不得只提交另一个计划。
- 批次 2：B04，A01/A02/A03/A04/A05/A07/A08/A09，I01/I04，Q03/Q06。
  在隔离环境收敛状态一致性、调度、权限、并发、分页、恢复，再提交涉及生产的待批准步骤。
- 批次 3：D01 至 D12、A11/A18 及 F01/F02/F09/F10。先共用组件后页面，视觉基线由站长审阅。
  D02 虽为 P2，但其令牌整理是多项 P1 的依赖；先做这些依赖的必要部分，不以优先级标签阻断它们。
- 批次 4：剩余 F、A、I 任务，包括 A06/A10/A12/A13/A14/A17 与可选 I06，逐页面族补真实内容和运营流程。
- 批次 5：Q01 至 Q09 全量复验、真机和恢复签字。P0 清零，P1 清零或由站长明确缩减范围并签字。

每批必须提交：任务 ID、commit、不可变部署记录、失败前/修复后测试、前后截图及差异、覆盖分母与剩余差集、迁移/权限变化和回滚方案。
状态分为待执行、进行中、阻塞、待验收、已验收、不适用；只有证据和审批齐全才标已验收。
没有真实服务、凭据或真机时记录阻塞，继续可独立的实现，不得用 mock 结果冒充真实结果。

## 明确禁止越过的边界

- 本 PR 不授权合并 `main`、正式上线、执行生产 SQL、启用生产 cron、群发邮件、删除生产数据或修改生产账号权限。
- 上述动作均需站长另行批准。故障注入、越权、批量、导入、删除、恢复测试仅使用授权隔离环境与合成数据。
- 凭据由安全环境注入，不写入文档、代码、截图、HAR、trace 或日志；证据须脱敏。
- 不删除失败用例，不放宽断言或性能预算，不扩大截图 mask，不自动接受视觉基线来制造全绿。
- 遇到产品政策决策，例如版主可否改他人正文、敏感画像保留期、CMS 范围、RPO/RTO，列出建议和阻塞项交站长确认，不擅自决定生产策略。

## 完整任务清单

各项“证据”中的类型区分实测、源码风险、待验证和建议，不把建议冒充既成缺陷。
全部任务初始状态为待执行；具体用例步骤和预期结果在配套测试方案，任务与用例 ID 一一可追踪。

## B：基线与交付流程

### B01 | P0 | 锁定审计与部署版本

- 证据类型：验收前置。依赖：无。
- 实施：记录 PR head、构建环境、不可变部署 URL、迁移版本及启用功能；当前分支别名必须与本次 SHA 对齐。
- 验收：每份截图/测试报告均有 SHA、部署、时间、视口、角色；版本不一致时重跑而非混用。
- 用例：T001。来源：[PR]、[LIVE]、[CI]。

### B02 | P0 | 生成完整路由与截图覆盖账本

- 证据类型：验收前置。依赖：B01。
- 实施：从真实构建产物导出 HTML URL，合并动态论坛/用户种子状态；与源码清单对账；遍历全页而非只拍首页。
- 验收：应测、已测、阻塞、豁免均有分母；每个实际路由至少桌面/手机浅深色首屏及 fullPage 截图；不得把模板数量当页数。
- 用例：T002。来源：[ROUTES]、[ASTRO]、[VISUAL]。

### B03 | P0 | 建立隔离的真实集成预览环境

- 证据类型：运行待验证。依赖：B01。
- 实施：配置可访问预览、隔离 Supabase、版主/管理员/普通/封禁测试账号；凭据通过安全方式注入，使用合成数据。
- 验收：真实后台可进入；不把 mock 或生产账号数据灌进截图；Auth/REST/Storage/邮件各标真实或模拟。
- 用例：T003。来源：[AUTH_TEST]、[IMAGE_TEST]、[DEPLOY]。

### B04 | P0 | 补齐迁移 0017 的发布与回滚证据

- 证据类型：生产待授权。依赖：B03。
- 实施：先读取生产迁移台账，只执行缺失迁移；在克隆库演练、备份、对象/策略/授权核对；生产执行另经站长批准。
- 验收：迁移前后数据量与策略差异可审计；0017重跑无破坏；状态查询与真实角色 canary 通过；有可执行回滚/恢复预案。
- 用例：T004。来源：[PR]、[MIGRATION]、[STATUS]。

### B05 | P1 | 建立 Hark 分批交付与验收约定

- 证据类型：执行流程。依赖：B01。
- 实施：按本清单关联提交、测试和截图；每批先失败用例后修复；禁止通过删除用例或接受新快照掩盖回归。
- 验收：每项有 commit、修复前后证据、测试编号、残余风险；未发送/未运行不能标完成；发布和生产写入需站长单独批准。
- 用例：T005。来源：[SIGNOFF]、[CI]。

## D：设计系统与交互

### D01 | P1 | 补齐手机端主导航的信息架构

- 证据类型：源码及页面确认。依赖：B03。
- 实施：底栏保留最多5项，可改为4个高频项+更多；AI/视频/作品使用同一 NAV 数据生成更多面板。
- 验收：390和320宽从任意页最多2次操作可到全部主栏目；当前栏目有文字和aria-current；焦点、Esc、底部安全区正确。
- 用例：T006。来源：[SITE]、[LIVE]。

### D02 | P2 | 统一设计令牌并清理无效变量

- 证据类型：源码风险。依赖：B01。
- 实施：核查 store.css 中 --dur-base 与生成 token；清理同义间距、圆角、颜色和动效时长，设置例外白名单。
- 验收：构建产物没有未定义 CSS var；图标/图片过渡 computed style 正确；reduce 模式仍无不必要位移。
- 用例：T007。来源：[STORECSS]、[TOKENS]、[DESIGN]。

### D03 | P1 | 把紧凑视觉和真实点击区域分开

- 证据类型：源码风险及目标。依赖：D02。
- 实施：保留紧凑视觉尺寸，触控主操作用显式44×44 CSS px命中区；检查伪元素补区是否与邻项冲突。
- 验收：触屏主CTA/导航/图标按钮命中框达到项目44px目标且不重叠；不把WCAG的24px最低要求误写成44px。
- 用例：T008, T079。来源：[STORECSS]、[CSS]、[APPLE]、[WCAG_TARGET]。

### D04 | P1 | 统一图标源、品牌资产和许可清单

- 证据类型：产品建议及合规待核。依赖：D02。
- 实施：UI图标复用24网格/统一线宽组件；清理手写重复SVG，品牌图标独立登记；保留故障兜底和第三方许可证。
- 验收：16/20/24尺寸清晰一致；非装饰图标有可访问名称；有上游版本与许可链；不未经核验移植SF Symbols或打包苹果字体。
- 用例：T009。来源：[ICON]、[DESIGN]。

### D05 | P1 | 完善浅深色、跟随系统和强制色模式

- 证据类型：源码风险。依赖：D02。
- 实施：系统主题变更同步theme-color；select箭头改可继承颜色的实现；明确高对比与无blur回退。
- 验收：不刷新 light→dark→light 时网页及浏览器主题同步；手动主题不被覆盖；强制色下边界/选中/箭头可辨。
- 用例：T010, T080。来源：[THEME]、[SHELL]、[CSS]。

### D06 | P1 | 给长标题和中英文混排制定可执行规则

- 证据类型：视觉建议及边界验证。依赖：D02。
- 实施：卡片用短展示标题或明确两行规则，详情保留全名；避免单字孤行和超长版本号撑宽；不靠无差别截断掩盖内容。
- 验收：320/390/768/1440及200%文字下长中文、英文URL、缺图样本不横向溢出；完整标题可读取。
- 用例：T011, T082。来源：[STORECSS]、[DESIGNQA]、[LIVE]。

### D07 | P1 | 完善菜单、弹窗与跨平台快捷键

- 证据类型：源码风险。依赖：D02。
- 实施：账户链接优先用disclosure语义；若保留menu则补完整键盘行为；⌘/Ctrl提示按平台且不拦截输入法/输入框。
- 验收：Tab能离开并关闭菜单，Esc返回触发器；模态焦点不泄漏；快捷键不吞中文输入或浏览器常用键。
- 用例：T012。来源：[MENU]、[DESIGNQA]。

### D08 | P2 | 约束动效与玻璃效果成本

- 证据类型：产品建议及待验证。依赖：D02。
- 实施：仅在必要层用透明材质；普通卡片以实色、边界和层级取胜；减少动态时取消位移、缩放和持续旋转。
- 验收：无动画也有状态反馈；低性能真机滚动不出现持续掉帧；无backdrop-filter时文字仍清晰。
- 用例：T013, T081。来源：[CSS]、[DEVICE]。

### D09 | P1 | 把焦点、读屏和状态反馈补到全站

- 证据类型：验收任务。依赖：D01,D03,D07。
- 实施：主路径检查跳转、加载、空/错态、表单错误、aria-live与aria-busy；颜色之外提供状态文本/图标。
- 验收：axe严重/致命0；VoiceOver/NVDA走通搜索、详情、表单和后台；固定栏不遮挡焦点。
- 用例：T014, T079。来源：[DESIGNQA]、[WCAG_FOCUS]。

### D10 | P1 | 验证文字放大、重排和字体回退

- 证据类型：验收任务。依赖：D06。
- 实施：200%文字、400%缩放、320 CSS px重排；系统字体栈覆盖Windows/Android中文与中英文混排。
- 验收：正文/操作不重叠丢失；除必要二维表格外无整页横向滚动；高密度不以12px以下正文换空间。
- 用例：T015。来源：[WCAG_REFLOW]、[DEVICE]。

### D11 | P2 | 统一卡片元数据与视觉辨识度

- 证据类型：视觉建议。依赖：D02,D06。
- 实施：减少“类型/作者/平台/日期”重复；给自研应用和游戏保留独立图标辨识度；货架排序符合阅读顺序。
- 验收：同一模板卡片标题和CTA基线稳定；日期和状态有层级；横滑有清晰提示但不强制每个宽度都露固定48px。
- 用例：T016。来源：[STORECSS]、[DESIGN]、[LIVE]。

### D12 | P1 | 统一响应式壳与详情操作区

- 证据类型：验收任务。依赖：D03,D10。
- 实施：断点依据内容而非设备名字；桌面侧栏可粘附，手机CTA/抽屉/软键盘遵守safe-area和visual viewport。
- 验收：横竖屏、短屏和软键盘不遮主要操作；所有详情类型按钮层级一致；用户选择平台后不会被设备检测覆盖。
- 用例：T017。来源：[DEVICE]、[AUDIT4]、[LIVE]。

## F：前台页面与内容

### F01 | P1 | 压缩手机首页与列表的首屏工具区

- 证据类型：实测视觉问题。依赖：D01,D03,D06。
- 实施：优先重排AI列表的标题说明、类别、更多筛选、排序和视图切换；保留清晰标签而非一味缩字。
- 验收：390×844默认字号时首个结果卡完整含CTA；常用筛选/排序两行内，其余收纳；200%文字允许自然增高。
- 用例：T018。来源：[LIVE]、[STORECSS]。

### F02 | P1 | 统一应用目录、分类、平台、排序与视图状态

- 证据类型：验收任务。依赖：D06。
- 实施：复用查询状态模型，定义URL优先于本地偏好；全局或分栏目视图偏好需明确；筛选后纠正页码。
- 验收：刷新/分享/后退可还原筛选排序；无结果、越界页、未知参数有明确回退；跨栏目不意外覆盖已选偏好。
- 用例：T019, T071。来源：[LIST]、[ROUTES]。

### F03 | P1 | 让应用和AI详情的主要操作与状态一致

- 证据类型：产品建议及交付风险。依赖：D12。
- 实施：区分在线使用、官方商店、官方安装包、即将上线；优先展示当前设备推荐但保留其他平台，不因加载后重排制造CLS。
- 验收：全部平台组合验证；无URL不显示可下载承诺；推荐CTA显著且稳定；安装指令可复制并有失败反馈。
- 用例：T020。来源：[FABLE]、[AUDIT4]、[LIVE]。

### F04 | P1 | 补真实发布渠道和产品截图

- 证据类型：源码及页面确认。依赖：F03。
- 实施：8个自研应用逐个确认是档案、内用还是可发布；真实下载/试玩/截图缺失就明确待发布；不要用生成图冒充运行截图。
- 验收：每个发布项有可用渠道、版本、系统要求、来源及必要校验；概念图在卡片/详情/OG一致标识。
- 用例：T021。来源：[FABLE]、[LIVE]。

### F05 | P1 | 修正 EMBERDEEP 试玩承诺

- 证据类型：实测内容矛盾。依赖：F03。
- 实施：补真实playUrl并验证，或将正文“Demo可以直接在浏览器里玩”改为准确待发布描述；同步关于页Demo承诺。
- 验收：摘要、正文、状态、CTA和实际目的地一致；无死入口；触屏尚不可玩时说明控制器/键鼠要求。
- 用例：T022。来源：[EMBER]、[LIVE]。

### F06 | P2 | 提升文章列表和阅读体验

- 证据类型：视觉建议及验收任务。依赖：D06,D09。
- 实施：摘要改人工可读短导读，减少截断后的半句话；核对目录锚点、代码块、表格、分享和移动阅读。
- 验收：4列高密度下摘要仍易扫读；详情中文行长约32至42字作为目标；锚点不被导航遮挡；代码可横滚不撑页。
- 用例：T023。来源：[LIVE]、[DESIGN]。

### F07 | P1 | 验证视频的播放、章节与隐私承诺

- 证据类型：验收任务。依赖：B03,D12。
- 实施：用真实可嵌入视频验证点播、章节跳转、全屏、阻止第三方加载、地区/网络/禁嵌失败和外站回退。
- 验收：未点击前不连视频第三方；点击后可播放或有可恢复错误；无自动播放；横竖屏及返回保留合理位置。
- 用例：T024, T077。来源：[LIVE]。

### F08 | P1 | 把作品档案与精选视频明确分区

- 证据类型：实测内容一致性风险。依赖：D04,D06。
- 实施：作品页说明生成式素材，却有卡片称开发中截图；逐项区分概念图、真实截图、视频、过程稿；详情补角色/方法/结果。
- 验收：作品卡片与详情真实类型一致；可放大查看和键盘关闭；与视频栏目互相推荐但不重复混淆导航。
- 用例：T025。来源：[LIVE]。

### F09 | P1 | 让论坛首屏出现主题并验证动态内容

- 证据类型：实测视觉问题及验收任务。依赖：B03,D01。
- 实施：分类改紧凑网格/折叠；保留发帖和搜索；动态UUID主题覆盖匿名可见性、加载失败、已删/锁定/封禁等状态。
- 验收：390×844首屏至少完整显示第一条主题；有效/无效主题可区分；失败能重试；不能以静态种子页代替真实社区验证。
- 用例：T026。来源：[LIVE]、[THREAD]。

### F10 | P1 | 修复搜索类型丢失和结果摘要噪声

- 证据类型：实测功能问题。依赖：D06。
- 实施：将q/type纳入URL并恢复popstate；搜索索引用业务摘要替代标题下拼接的作者/平台/价格原文；请求竞争只显示最新结果。
- 验收：实测Claude→视频→刷新仍为视频；分享/后退还原；结果不出现杂乱字段堆砌；中文/拼音/无结果均正常。
- 用例：T027, T071, T072。来源：[LIVE]、[SEARCH]。

### F11 | P1 | 核对个人介绍、联系、法律与中英文页面

- 证据类型：验收任务。依赖：B02。
- 实施：逐页确认作者身份、联系渠道、授权、免责声明及隐私处理实际一致；英文页面语言切换回同一实体。
- 验收：没有占位联系信息、错语言跳转、死锚点；合法basis/保留期/外链与实际功能一致；不把不完整翻译标为全站双语。
- 用例：T028, T083。来源：[SITE]、[LIVE]。

### F12 | P1 | 走通留言、友链申请、订阅和退订

- 证据类型：真实集成待验证。依赖：B03。
- 实施：真实Turnstile和邮件环境验证提交、重复、频率限制、审核状态、确认/过期链接和退订。
- 验收：不提交也不泄露邮箱存在性；失败不丢输入；重复请求幂等；退订后后续发送遵守偏好。
- 用例：T029, T089。来源：[DEPLOY]、[AUTH_TEST]。

### F13 | P1 | 验证账户、设置、收藏与通知完整流程

- 证据类型：真实集成待验证。依赖：B03。
- 实施：登录注册找回、回调、会话过期、退出、跨标签同步；收藏/通知以真实DB验证并区分未读和已读。
- 验收：访客不会误见他人数据；过期可重登返回原页；注销清理私有缓存；错误状态有可执行出口。
- 用例：T030, T073。来源：[AUTH_TEST]、[SUPABASE]。

### F14 | P1 | 复测404、500、离线与旧链接更新

- 证据类型：验收任务。依赖：B03。
- 实施：测试不存在URL而非只直达404模板；验证旧hash跳转、离线壳、SW升级、恢复联网与隐私缓存策略。
- 验收：HTTP状态正确；旧链接到正确页面；离线不伪装提交成功；恢复不会丢草稿或重复写入；后台私有数据不进公共缓存。
- 用例：T031, T078, T084。来源：[LIVE]、[ROUTES]。

## A：后台与数据可靠性

### A01 | P0 | 统一隐藏恢复与内容工作流状态

- 证据类型：源码确认风险。依赖：B03。
- 实施：setPublished直接PATCH与mod_set_workflow两条路径统一为事务性状态接口，或使用可靠同步约束；明确定时取消语义。
- 验收：published、workflow.status/scheduled_at、列表徽标和匿名查询始终一致；隐藏待发布内容不会意外再次上线。
- 用例：T032, T061, T063。来源：[ADMINAPI]、[ADMINUI]、[SQL17]。

### A02 | P1 | 修复已删目标的定时发布假成功

- 证据类型：源码确认风险。依赖：A01。
- 实施：tick核对目标存在与UPDATE行数；删除目标清理/标记孤儿；版本历史保留按政策处理，不默认无痕删除。
- 验收：删掉已排程的主题/回复/评论后tick不计成功、不写成功审计；并发删除可恢复且有明确异常记录。
- 用例：T033。来源：[SQL17]、[ADMINAPI]。

### A03 | P0 | 落地无人值守调度与告警

- 证据类型：文档确认限制。依赖：B04,A01,A02。
- 实施：部署受监控pg_cron或外部调度器；页面tick只作补偿；记录运行ID、延迟、成功/失败数量和重试。
- 验收：关闭所有后台浏览器仍按承诺发布；建议每分钟调度、到期2分钟内可见；双worker不重复发布；失败能告警。
- 用例：T034, T061, T062, T064。来源：[PR]、[SQL17]、[ADMINUI]。

### A04 | P0 | 收敛版主直接改他人正文的权限

- 证据类型：权限语义待决及源码风险。依赖：B03。
- 实施：先确认版主可否改正文；默认只允许审核标志；正文编辑单独权限/RPC、理由、版本、作者提示。
- 验收：按批准的角色×字段矩阵验证真实PostgREST PATCH；禁止的title/body/category修改被拒；合法审核仍可用。
- 用例：T035, T067, T068。来源：[GRANTS]、[RLS]、[GUARD]。

### A05 | P1 | 为备注和标签增删增加审计

- 证据类型：源码确认缺口。依赖：B03。
- 实施：notes/tags写入通过受控RPC或trigger记录最小审计；避免把敏感备注全文再次复制到日志。
- 验收：每次增删有actor/target/action/time/result和关联ID；越权/回滚不留假成功审计；只读用户无权读取。
- 用例：T036。来源：[SQL17]、[CRMAPI]。

### A06 | P1 | 限制画像敏感数据并记录访问

- 证据类型：隐私策略待决。依赖：A04,A05。
- 实施：IP/UA/订阅信息按用途最小化；默认脱敏，敏感揭示/导出独立权限和保留期；管理员可见本身不当成漏洞。
- 验收：版主不可获得被禁止字段；管理员读取/导出可追溯；截图和日志不含真实邮箱/IP/令牌。
- 用例：T037, T069。来源：[SQL17]、[CRMUI]。

### A07 | P1 | 为编辑与工作流增加并发冲突处理

- 证据类型：源码确认缺口。依赖：A01。
- 实施：正文更新带version/expected updated_at；过期保存返回冲突，提供重新加载/比较/合并；保留已有版本历史。
- 验收：A/B同时编辑不静默丢写；旧版本提交不覆盖最新正文；重试不重复审计或版本。
- 用例：T038, T066。来源：[SUPABASE]、[SQL17]。

### A08 | P1 | 给批量操作提供逐项结果和重试语义

- 证据类型：源码确认缺口。依赖：A01,A05。
- 实施：服务端先去重；返回每个ID成功/不存在/拒绝/失败；明确事务性或部分成功；网络重试使用幂等键。
- 验收：有效、已删、重复、无权ID混合时计数准确；UI能只重试失败项；选择范围和确认对象清楚。
- 用例：T039, T065。来源：[SQL17]、[ADMINAPI]、[CRMAPI]。

### A09 | P1 | 修复超出页尾时total变0

- 证据类型：源码确认风险。依赖：B03。
- 实施：列表返回独立total或响应envelope；空页可回到最后有效页；过滤/删除后纠正页码。
- 验收：offset=total或>total时总数仍正确；并发删末页不误报数据库为空；用户和内容列表均覆盖。
- 用例：T040, T070。来源：[SQL17]、[ADMINAPI]。

### A10 | P1 | 用真实规模验证后台搜索与统计

- 证据类型：性能待测。依赖：A09。
- 实施：合成1万/10万条数据并EXPLAIN；按结果选择trigram/全文索引、统计预聚合和keyset分页，勿盲加索引。
- 验收：约定测试规格下RPC p95≤500ms为初始目标；无超时；深页/无结果/多筛选有计划证据；不把小fixture当压测。
- 用例：T041。来源：[SQL17]、[CRMTEST]。

### A11 | P1 | 验收表格、记录抽屉和键盘工作流

- 证据类型：真实界面待测。依赖：B03,D07,D12。
- 实施：真实脱敏数据覆盖长文本/缺值/多行/空态/错误；列宽/顺序/密度记忆按用户；手机切换卡片或详情。
- 验收：排序是服务端全量排序；aria-sort正确；抽屉focus回归、未保存退出提示；列拖拽有非拖拽等价操作。
- 用例：T042, T064。来源：[ADMINUI]、[CRMUI]、[ADMINE2E]。

### A12 | P1 | 补导入导出与危险操作的防错

- 证据类型：验收任务。依赖：B03,A04,A08。
- 实施：导入有dry-run、字段校验和批次回滚策略；导出防CSV公式注入、脱敏与权限；删除/角色变更二次确认。
- 验收：无效/重复/大文件可报告行号；取消不产生副作用；导出范围完整不静默截断；恢复证据可核查。
- 用例：T043, T085。来源：[ADMINAPI]、[OPS]。

### A13 | P1 | 逐页验收后台运营与系统模块

- 证据类型：已读各模块；数据读取失败，业务流程未验。依赖：B03,A04。
- 实施：概览/举报/留言/友链/订阅/权限/审计/设置逐页验证数据新鲜度、空态、错误、无权限与安全操作。
- 验收：所有后台路由有角色和状态截图；真实计数可追溯；非管理员不会仅靠隐藏UI获得访问。
- 用例：T044, T068。来源：[OPS]、[ADMINE2E]。

### A14 | P1 | 区分官方Git内容与社区数据库发布

- 证据类型：源码与真实流程待核。依赖：B01,A01。
- 实施：官方内容走编辑→预览→PR→合并→部署；社区内容走DB工作流；核对预览环境Git编辑目标，避免默认误进main。
- 验收：UI明确何时前台生效；预览审核不误写生产；官方/社区均有发布后前台一致性测试和失败回滚说明。
- 用例：T045。来源：[SITE]、[OPS]、[DEPLOY]。

### A15 | P0 | 先恢复8个核心后台模块的数据读取

- 证据类型：已登录预览实测失败。依赖：B01,B03。
- 实施：概览/内容/用户/举报/留言/友链/订阅/审计均报网络或服务暂不可用；内容重试仍失败。采集脱敏Network状态、错误体、CORS、JWT/RLS、RPC签名及迁移台账，证实根因再修。
- 验收：8模块能读到正确数据或真实空态；重试有效；不用mock、隐藏错误或默认值掩盖失败；根因有证据。
- 用例：T091。来源：[LIVE]、[ADMINAPI]、[DEPLOY]。

### A16 | P0 | 设置加载失败时禁止默认值覆盖真实配置

- 证据类型：源码确认风险。依赖：A15。
- 实施：settings.ts的catch会fill默认值但保存仍可用；新增loaded/error/dirty状态，加载失败持久提示并禁用保存，成功重载后才允许编辑。
- 验收：读取失败或超时时无保存请求；真实配置不被默认值覆盖；重试成功显示真实值；慢请求不覆盖编辑。
- 用例：T092, T095。来源：[SETTINGS]、[LIVE]。

### A17 | P1 | 补齐官方内容管理遗漏的AI与视频

- 证据类型：源码及页面确认。依赖：A14。
- 实施：官方页只列应用8/游戏9/文章15/作品12，共44条，未列AI工具30/视频24。纳入统一清单、编辑/历史/预览链接；核对main分支策略。
- 验收：固定基线6类98条内容都可发现；新增集合不再手工漏接；编辑目标分支符合环境策略。
- 用例：T093。来源：[OFFICIAL]、[SITE]、[LIVE]。

### A18 | P1 | 修复手机权限矩阵的纵向文字柱与局部空白

- 证据类型：手机视口实测布局问题。依赖：D07,D10,D12。
- 实施：390×844权限能力列被挤成每行1至2字；改能力卡片或局部横滚表格；核查用户详情缺参态的大块头部空白和搜索图标名称。
- 验收：完整能力描述可读；表格局部滚动但整页不横溢；缺参态无异常占位；搜索按钮可访问名称含功能名。
- 用例：T094。来源：[LIVE]、[DESIGNQA]。

## I：真实服务与安全

### I01 | P0 | 验收真实Auth、OAuth、验证码和邮箱链路

- 证据类型：真实集成待验证。依赖：B03。
- 实施：隔离环境走真实注册确认/密码找回/GitHub回调/PKCE/Turnstile成功失败与限流；不可只用mock。
- 验收：每条链路有真实服务证据；过期/重复token/错误redirect被拒；不在报告暴露密码、cookie或密钥。
- 用例：T046, T074。来源：[AUTH_TEST]、[DEPLOY]。

### I02 | P1 | 验收文件上传和Storage边界

- 证据类型：真实集成待验证。依赖：B03。
- 实施：真实桶测类型、大小、MIME伪造、对象归属、签名过期、CORS、删除与失败重试；内容安全处理按文件类别。
- 验收：用户只能读写授权对象；无脚本执行/公开敏感对象；失败能恢复；RLS测试和真实Storage API证据分别保存。
- 用例：T047, T075。来源：[IMAGE_TEST]、[DEPLOY]。

### I03 | P1 | 验证所有下载与外链中转

- 证据类型：验收任务。依赖：F03,F04。
- 实施：逐项检查目标域名、重定向、OS/架构、版本、费用与许可；不要在审计中盲下载执行安装包。
- 验收：可发布项没有死链/误导下载；无URL明确待发布；直链校验/签名适用时可核；离站提示与实际一致。
- 用例：T048。来源：[FABLE]、[LIVE]。

### I04 | P0 | 验证服务端授权、输入和部署安全边界

- 证据类型：安全验收任务。依赖：B03,A04。
- 实施：在隔离环境执行RLS/RPC/IDOR/XSS/CSRF/开放跳转/CSP/缓存隔离测试；复核security-definer/search_path与授权。
- 验收：禁止路径不能读写他人数据；恶意输入不执行；正式部署头与构建测试一致；不对生产做破坏性测试。
- 用例：T049, T089。来源：[RLS]、[GRANTS]、[GUARD]、[CI]。

### I05 | P1 | 验证订阅邮件可靠性和合规边界

- 证据类型：真实集成待验证。依赖：F12,B03。
- 实施：真实测试收件箱检查确认/退订/重复发送幂等、SPF/DKIM/DMARC、退订头、暗色客户端和禁用JavaScript。
- 验收：Gmail/Outlook/iOS Mail可读可退订；失败重试不重复轰炸；SMTP/服务商失败可告警；只发给授权测试收件人。
- 用例：T050, T076。来源：[DEPLOY]、[OPS]。

### I06 | P1 | 可选 CMS 的 GitHub OAuth 与仓库权限验收

- 证据类型：交付范围及真实集成待核。依赖：A14,B03。
- 实施：官方页当前明确Git-only、无CMS写入；先确认已有CMS接口是否启用并纳入交付。若纳入，才验证真实OAuth、仓库最小权限、分支、PR创建及预览回链。不要把未启用功能说成已交付。
- 验收：无权仓库不可写；用户审批前不合并main；操作记录与PR/部署可对应；没有把协议mock标为真实可用；未纳入范围时登记不适用及站长依据，不标测试通过。
- 用例：T051。来源：[DEPLOY]、[OPS]。

## Q：质量与发布

### Q01 | P0 | 补全路由渲染与状态覆盖

- 证据类型：测试覆盖确认缺口。依赖：B02。
- 实施：现有tags只取前3页；增加每个生成HTML至少1次结构/无障碍smoke，动态页用明确种子状态；完整截图独立任务。
- 验收：最终构建HTML清单与测试/截图集合差集为空或逐项批准豁免；无隐形skip；API/Feed不混算HTML页面。
- 用例：T052, T083, T084。来源：[ROUTES]、[CI]。

### Q02 | P1 | 保护视觉回归基线与整页截图

- 证据类型：质量门禁。依赖：B02。
- 实施：保留已有toHaveScreenshot；基线变更必须人工看差异；update_visual仅生成待审产物；关键区不被mask隐藏。
- 验收：正常回归不带update-snapshots；首屏及整页/弹窗/错误态都有证据；字体和动画稳定后拍图。
- 用例：T053, T088。来源：[VISUAL]、[CI]、[SIGNOFF]。

### Q03 | P1 | 补CRM负面和并发回归

- 证据类型：测试缺口。依赖：A01,A02,A04,A05,A07,A08,A09。
- 实施：保留现有0017排序/权限/工作流happy path，新增漂移、孤儿、空页、越权正文、双tick/双会话和审计用例。
- 验收：每个A01至A09关键不变量有失败前/通过后结果；Postgres+PostgREST真实角色测试可复现。
- 用例：T054。来源：[CRMTEST]、[ADMINE2E]。

### Q04 | P1 | 补真实跨平台和辅助技术签字

- 证据类型：验收任务。依赖：B03,D09,D10,D12。
- 实施：3引擎自动化之外执行macOS Safari、iOS Safari、Android Chrome、Windows Edge/Firefox；记录设备/版本/缩放/输入法。
- 验收：真机软键盘/安全区/回退/滚动/读屏通过；不能把WebKit或viewport称为iPhone真机。
- 用例：T055。来源：[DEVICE]、[SIGNOFF]。

### Q05 | P1 | 增加真实交互性能与部署预算

- 证据类型：性能覆盖缺口。依赖：B03。
- 实施：保留现有Lighthouse严门槛；对搜索、菜单、后台抽屉和长列表记录交互trace；上线后监测真实用户CWV。
- 验收：实验室移动LCP≤1.9s、桌面≤1.5s、CLS≤0.02按现有配置；真实用户p75 INP≤200ms/LCP≤2.5s/CLS≤0.1需样本足够才判定。
- 用例：T056, T087。来源：[LH]、[LH_DESK]、[CWV]。

### Q06 | P0 | 验证真实备份和恢复而非成功跳过

- 证据类型：运维验收缺口。依赖：B04。
- 实施：缺密钥不标备份成功；从实际备份恢复到隔离环境；覆盖DB对象/权限与Storage、Auth配置、邮件模板等非dump清单。
- 验收：备份可下载、解密、恢复、校验；有最近成功时间/大小/恢复证据；RPO/RTO由站长批准并演练。
- 用例：T057, T086。来源：[BACKUP]、[BACKUPDOC]。

### Q07 | P1 | 配置合成监测和可执行告警

- 证据类型：运维建议。依赖：A03,I01,I02,I05。
- 实施：分别监测公开页面、REST、Auth、Storage、邮件、cron、部署和备份；脱敏日志带trace/batch/job关联ID。
- 验收：故意注入失败能触发到指定负责人，恢复可见；保活读一行不再等同全系统健康。
- 用例：T058。来源：[OPS]、[BACKUP]。

### Q08 | P1 | 统一README、迁移、验收与设计审计文档

- 证据类型：文档一致性缺口。依赖：B01,Q01,Q03。
- 实施：更新0017、真实测试边界和历史已修项；把开发自评分与独立验收分开；版本化记录每个未关闭风险。
- 验收：不再以旧85页面数/旧41px问题/模拟截图冒充现状；文档清单、代码和CI命令一致。
- 用例：T059。来源：[AUDIT4]、[MIGRATION]、[ACCEPT]。

### Q09 | P0 | 执行最终商业交付签字与回滚演练

- 证据类型：发布门禁。依赖：除本项外全部P0/P1。
- 实施：逐项关闭P0/P1，验收真实入口、全部路由、角色、第三方集成、无障碍、视觉、性能与运维；保留剩余风险。
- 验收：未解决P0为0；已知P1为0或站长明确改变发布范围并签字；所有豁免可见；不承诺数学意义零缺陷。
- 用例：T060, T090。来源：[SIGNOFF]、[ACCEPT]。

## 给 Hark 的开工指令

> 以本交接 PR 为任务合同，先读取两份文档并核对最新 `v2/astro` 与审计基线差异。
> 建立隔离真实集成环境和覆盖账本，优先交付 A15 后台读取恢复、A16 设置写保护及 T091/T092/T095 的实现和证据。
> 随后按批次完成 64 项任务及 95 项适用用例，每批提交可审查 PR、失败前后测试和截图。
> 不用计划或自评分代替实现，不把 mock/模拟视口说成真实服务/真机，不未经站长批准合并或操作生产。

## 来源索引

源码链接固定在审计 SHA。LIVE 仅是浏览器审计记录，访问权限与 GitHub 独立；仓库文档内已保留重现信息。
外部标准是设计与验收参考，不是本项目已获得认证的声明。

[PR]: https://github.com/azsou/azsou-site/pull/2#issuecomment-6425731519
[LIVE]: https://app.clickup.com/9017520422/artifact/8cqrw96-1077
[AUDIT4]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/DESIGN-AUDIT-4.md
[SQL17]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/db/migrations/0017_admin_crm.sql
[ADMINAPI]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/lib/data/admin.ts
[ADMINUI]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/admin/content.ts
[SETTINGS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/admin/settings.ts
[OFFICIAL]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/pages/admin/official/index.astro
[CRMAPI]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/lib/data/admin-crm-api.ts
[CRMUI]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/admin/crm.ts
[CRMTEST]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/db/crm.test.ts
[ADMINE2E]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/e2e/admin.spec.ts
[STATUS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/db/verify/status.sql
[ROUTES]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/e2e/routes.ts
[SITE]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/lib/site.ts
[DESIGN]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/DESIGN-SYSTEM.md
[DESIGNQA]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/DESIGN-QA.md
[STORECSS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/styles/store.css
[CSS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/styles/components.css
[TOKENS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/styles/tokens.css
[SHELL]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/site-shell.ts
[THEME]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/theme.ts
[MENU]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/user-menu.ts
[SEARCH]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/search-page.ts
[LIST]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/scripts/list-shell.ts
[ICON]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/lib/lucide.ts
[FABLE]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/content/apps/fablemotion.md
[EMBER]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/content/games/emberdeep.md
[THREAD]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/pages/forum/t/index.astro
[SUPABASE]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/src/lib/data/supabase.ts
[RLS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/db/migrations/0006_rls.sql
[GRANTS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/db/migrations/0005_privileges.sql
[GUARD]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/db/migrations/0004_functions_triggers.sql
[CI]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/.github/workflows/ci.yml
[VISUAL]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/visual/visual.spec.ts
[BACKUP]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/.github/workflows/db-backup.yml
[BACKUPDOC]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/BACKUP.md
[MIGRATION]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/MIGRATION.md
[ACCEPT]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/ACCEPTANCE.md
[SIGNOFF]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/SIGNOFF.md
[DEVICE]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/DEVICE-MATRIX.md
[OPS]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/OPERATIONS.md
[DEPLOY]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/docs/DEPLOY.md
[AUTH_TEST]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/e2e/auth.spec.ts
[IMAGE_TEST]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/tests/e2e/images.spec.ts
[LH]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/lighthouserc.cjs
[LH_DESK]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/lighthouserc.desktop.cjs
[ASTRO]: https://github.com/azsou/azsou-site/blob/2794ccb62e016ee9cb2dbc419448427844c73485/astro.config.mjs
[APPLE]: https://developer.apple.com/design/human-interface-guidelines/buttons.md
[WCAG_TARGET]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
[WCAG_REFLOW]: https://www.w3.org/WAI/WCAG22/Understanding/reflow
[WCAG_FOCUS]: https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
[CWV]: https://web.dev/articles/defining-core-web-vitals-thresholds
