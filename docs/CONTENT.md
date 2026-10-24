# 内容指南：添加 / 更新一个应用

应用商店里的每个应用是 `src/content/apps/<slug>.md` 一个文件：开头是 JSON 格式的「档案」（frontmatter），后面是介绍正文（HTML）。
构建时用 Zod 校验（`src/content.config.ts`），字段写错、缺必填项、直链没有 SHA-256 都会让构建直接失败，不会带病上线。

改完提 PR（或直接在 GitHub 网页上编辑文件），Vercel 预览站会自动构建，确认无误后合并即上线。

---

## 1. 站点原则（写之前先看）

- **只写真实信息**。不知道的字段就不写（页面会显示「开发者未提供」），不要编数字。
- **评分和下载数不写在这里**。它们来自数据库里的真实用户评价（`app_reviews`）与真实下载计数（`app_count_download`），页面自动读取。
- **第三方软件只链官方渠道**（官网 / 应用商店 / GitHub Release），不要把别人的安装包放到本站再分发。
- **自研软件的直链必须附 SHA-256**（`linkType: "direct"` 时构建强制检查）。
- **概念图必须标注**：生成的界面概念图（不是真实截图）要写 `"illustrative": true`，`alt` 里写「概念图：……」，页面会显示「概念图 · 非真实截图」角标和说明。
- 下载按钮附近不放广告（P8 接入 AdSense 时由 `AdSlot` 组件保证）。

## 2. 新建一个应用：最小模板

文件名就是网址：`src/content/apps/my-tool.md` → `https://azsou.com/apps/my-tool/`。
文件名只能用小写字母、数字和 `-`，不能叫 `page`、`category`、`platform`、`icons`、`screens`（与目录页地址冲突）。

```json
---
{
  "title": "My Tool",
  "subtitle": "一句话说明（≤ 30 字）",
  "summary": "一两句话的简介，用在列表、搜索结果和搜索引擎描述里。",
  "icon": { "src": "/apps/icons/my-tool.png", "placeholder": false },
  "hue": "blue",
  "developer": { "name": "Randy Hopkins", "url": "/about/", "type": "self" },
  "category": "utilities",
  "tags": ["offline", "single-file"],
  "platforms": [
    {
      "os": "windows",
      "version": "1.0.0",
      "size": "18.4 MB",
      "requirements": "Windows 10 及以上",
      "linkType": "github",
      "url": "https://github.com/azsou/my-tool/releases/tag/v1.0.0"
    }
  ],
  "price": { "model": "free" },
  "license": "MIT",
  "openSource": true,
  "sourceRepo": "https://github.com/azsou/my-tool",
  "changelog": [{ "version": "1.0.0", "date": "2026-11-01", "notes": ["首个公开版本"] }],
  "updated": "2026-11-01",
  "version": "1.0.0",
  "status": "可用",
  "statusClass": "stable",
  "order": 9
}
---

<p>这里写介绍正文（HTML）。可以用 &lt;h2&gt;、&lt;ul&gt;、&lt;p&gt; 等标签。</p>
```

## 3. 字段说明

| 字段                                          | 必填 | 说明                                                                                                                                                                              |
| --------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                                       | ✅   | 应用名称                                                                                                                                                                          |
| `subtitle`                                    | ✅   | App Store 式副标题，≤ 30 字                                                                                                                                                       |
| `summary`                                     | ✅   | 列表与 SEO 描述                                                                                                                                                                   |
| `icon.src`                                    | ✅   | `/apps/icons/<slug>.png｜svg｜webp`，正方形，建议 1024×1024；圆角由页面裁切，**图片本身不要做圆角**                                                                               |
| `icon.placeholder`                            |      | `true` = 临时图标（页面图标下方显示「临时图标」）                                                                                                                                 |
| `icon.variants`                               |      | `true` = 同目录有 `<slug>-{64,128,256,512}.{avif,webp}`（`scripts/icons/render.mjs` 生成），页面用 `<picture>` 按尺寸选图                                                         |
| `hue`                                         | ✅   | 主题色：`accent` `green` `teal` `blue` `orange`                                                                                                                                   |
| `developer`                                   | ✅   | `name`、`url`（可选，站内路径或 https）、`type`：`self`（本站作者）或 `third-party`（第三方）                                                                                     |
| `category`                                    | ✅   | `creative` 创作工具 · `browser-tools` 浏览器工具 · `utilities` 效率工具 · `ai` AI 工具 · `dev-tools` 开发工具 · `games` 游戏（新增分类改 `src/lib/app-store.ts` 的 `CATEGORIES`） |
| `tags`                                        |      | 小写英文标签，用于「相关应用」                                                                                                                                                    |
| `platforms[]`                                 | ✅   | 每个平台一项，同一平台只能出现一次（见下一节）                                                                                                                                    |
| `screenshots[]`                               |      | 见第 5 节                                                                                                                                                                         |
| `price.model`                                 |      | `free` 免费 · `freemium` 免费 + 付费功能 · `paid` 付费（配 `price.amount`，如「¥18」）· `tbd` 价格待定（默认）。只有 `free` 会在结构化数据里写 `offers`                           |
| `license` / `openSource`                      | ✅   | 许可协议文字；是否开源                                                                                                                                                            |
| `website` / `sourceRepo`                      |      | 官网、源码仓库（https）                                                                                                                                                           |
| `privacy`                                     |      | `collects`：收集的数据（空数组 = 不收集）；`note`：补充说明；`policyUrl`：隐私政策链接。不写 = 页面显示「开发者尚未提供隐私说明」                                                 |
| `changelog[]`                                 |      | 按版本的更新日志，**新的在前**：`version`、`date`（YYYY-MM-DD）、`notes`（字符串数组）。第一条显示为「新功能」                                                                    |
| `faq[]`                                       |      | `q` / `a`                                                                                                                                                                         |
| `featured`                                    |      | 编辑推荐                                                                                                                                                                          |
| `releaseDate` / `updated`                     |      | 首次发布日期 / 最近更新日期（目录「最新」排序用；没有更新记录就不写，排在最后）                                                                                                   |
| `version` / `status` / `statusClass`          | ✅   | 当前版本、状态文字、状态样式：`active` `review` `stable` `experiment`                                                                                                             |
| `order`                                       | ✅   | 同一天更新时的先后                                                                                                                                                                |
| `relatedArticles` / `verification` / `issues` |      | 相关文章 slug、验证记录、已知问题（沿用 v2 原有字段）                                                                                                                             |
| `ownerReview` / `ownerTodo`                   |      | 档案不完整时 `ownerReview: true`（页面显示提示）；`ownerTodo` 列出还缺什么（只给站长看，不对访客展示）                                                                            |

## 4. 平台与下载地址

`os`：`ios` · `android` · `windows` · `macos` · `linux` · `web`（网页版）· `cli`（命令行）· `browser-ext`（浏览器扩展）· `ai-bot` · `mcp`

`linkType`：

| 值         | 含义                                  | 示例地址                                                |
| ---------- | ------------------------------------- | ------------------------------------------------------- |
| `direct`   | 直接下载安装包（**须附 `sha256`**）   | `https://github.com/azsou/x/releases/download/v1/x.zip` |
| `official` | 官方网站的下载页                      | `https://example.com/download`                          |
| `store`    | 应用商店（Chrome 商店、App Store 等） | `https://chromewebstore.google.com/detail/...`          |
| `github`   | GitHub Release 页                     | `https://github.com/azsou/x/releases/tag/v1.0.0`        |
| `web`      | 在线使用（按钮文字是「打开」）        | `https://tool.example.com/`                             |

- 没有 `url` 的平台显示「暂未提供」，不会出现可点的下载按钮；加上 `"availability": "coming-soon"` 则显示禁用的「即将推出」，旁边出现「上线通知」（订阅 RSS，或在评论区留言）。拿到地址后填 `url`、删掉 `availability` 即可。
- 所有下载按钮都先到中转页 `/go/<slug>/<os>/`：显示目标域名、SHA-256 与校验命令，点击「继续前往」时记一次真实下载（同一访客 24 小时内只计一次，爬虫不计），然后跳到 `url`。
- 生成 SHA-256：Windows `certutil -hashfile 文件名 SHA256`；macOS / Linux `shasum -a 256 文件名`。把 64 位十六进制填进 `sha256`。
- 访客打开详情页时，页面会按设备自动把最合适的平台设为主按钮（同系统优先，其次网页版 / 扩展 / 命令行）。

## 5. 图标与截图

**图标**：放 `public/apps/icons/<slug>.png`，1024×1024，不要自带圆角和阴影（页面用 CSS 裁成 squircle）。
再生成多尺寸版本并在档案里写 `"variants": true`：

```bash
node scripts/icons/render.mjs <放 SVG 的目录> public/apps/icons   # 每个 <slug>.svg → 1024 PNG + 512/256/128/64 的 AVIF / WebP
```

现在的 8 个图标是 2026-10-25 代为设计的统一风格图标（手工 SVG，生成脚本 `scripts/icons/own-apps.py`）。换成自己的图标时，覆盖 `<slug>.png` 并重新生成多尺寸版本。

**截图**：放 `public/apps/screens/<slug>/<名字>.webp`（建议 WebP，单张 ≤ 300 KB），然后在档案里写：

```json
"screenshots": [
  { "src": "/apps/screens/my-tool/main.webp", "alt": "主界面：……", "device": "desktop", "width": 1600, "height": 1000 },
  { "src": "/apps/screens/my-tool/phone.webp", "alt": "手机上的……", "device": "phone", "width": 1179, "height": 2556 }
]
```

- `width` / `height` 写图片的真实像素（页面用它预留位置，避免加载时跳动；单元测试会核对）。
- `device`：`desktop`（建议 16:10）/ `tablet` / `phone`（建议 9:19.5）。第一张立即加载，其余懒加载。
- `alt` 写清楚截图里是什么（给读屏用户和搜索引擎）。
- 概念图（AI 生成的界面构想，不是真实截图）写 `"illustrative": true`，`alt` 以「<应用名> 概念图：」开头；页面显示「概念图」角标与说明，结构化数据里不会当作 `screenshot`。
  目前 8 个应用的截图都是概念图（2026-10-25 生成），拿到真实截图后直接替换文件、把 `illustrative` 改成 `false`。

## 6. 站长待补清单（2026-10-25 更新）

2026-10-25 站长授权代填了图标、截图与默认档案：

- **图标**：8 个应用换成统一风格的正式图标（iOS squircle、渐变底、每个应用一个专属图形），不再是「临时图标」。
- **截图**：每个应用 2–3 张 **概念图**（桌面 16:10，部分应用加手机 9:19.5），页面明确标注「概念图 · 非真实截图」。仓库和 V72 站点里都没有这些应用的可运行代码，所以无法拍真实截图。
- **默认档案**（可随时更正）：价格「免费」；许可「保留所有权利（免费使用）」；不开源；隐私「本应用不收集个人数据，所有处理在本地完成」（Sub2API：「仅在本机转发请求，不上传对话内容」）。平台沿用迁移时的推断（Image Atlas Pro / Capture Kit 浏览器扩展、职业技能树工具网页版、Sub2API 命令行）。
- **下载**：没有安装包的平台显示「即将推出」+「上线通知」，不会出现可点的下载按钮。

现在只缺站长本人能给的东西（每个应用的 `ownerTodo` 里也写了）：

1. **真实下载地址**：每个平台的官网 / 商店 / GitHub Release 链接；直链必须附 SHA-256。填上后删掉该平台的 `"availability": "coming-soon"`。
2. **可选：真实截图**：替换 `public/apps/screens/<slug>/` 里的概念图，并把 `illustrative` 改成 `false`、`alt` 去掉「概念图」。
3. **核对默认值**：价格、许可、是否开源、隐私说明、平台（尤其 Image Atlas Pro、Capture Kit、职业技能树工具、Sub2API 的平台与发布渠道）。有任何一项不对，直接改档案。

## 6A. AI 工具（/ai/，第三方）

AI 工具是另一个内容集合：`src/content/tools/<slug>.md`，网址 `https://azsou.com/ai/<slug>/`。和应用共用详情页布局、评价与 `/go/` 跳转计数，所以 **slug 不能和应用重名**（单元测试会检查）。

- 只链官方渠道：`linkType` 只能是 `official` / `github` / `store` / `web`，每个平台都必须有 https 地址；不允许直链、不在本站托管安装包。
- `developer.type` 固定 `third-party`，`developer.url` 写官网。
- `categories`：`agent`（AI Agent）· `vibe-coding` · `cli`（CLI 工具）· `ai-bot`（AI Bot）· `mcp`，可以多选，第一个是主分类（决定面包屑和分类页里的排序）。
- `summary`：一句话简介，40–140 字（建议 60–120），**自己写**，不要复制官网文案。
- 正文：至少 3 段原创介绍与点评（是什么、亮点与体验、适合谁与注意事项），最后一段注明核对日期和「图标版权归各自所有者」。
- `price.model`：`free` / `freemium` / `paid`，`price.note` 写计费方式；不写具体价格数字（会过期）。
- `version` 一般不写（页面显示「随官方更新」）；`lastChecked` 必填，每次核对官网后更新。
- 图标：从官网（apple-touch-icon / favicon）或官方 GitHub 账号头像取，存到 `public/ai/icons/<slug>.png`（256×256，透明图标垫白底），再生成 `-{64,128,256}.{avif,webp}`，写 `"variants": true`。实在拿不到就用字母标识（如 TRAE）。不要热链外站图片。

## 6B. 视频（/videos/，第三方视频嵌入）

视频是内容集合 `src/content/videos/<slug>.md`，网址 `https://azsou.com/videos/<slug>/`。文件名不能叫 `category`、`page`。

**原则**

- 只收录**可公开嵌入**的视频，优先官方频道。本站不下载、不转载视频，只保存缩略图与原创导读；页面注明「视频版权归原作者所有」。
- **不写播放量、点赞数**（会过期，也无法核实）。
- 标题、频道、可嵌入逐个用 YouTube oEmbed 核对；`duration`（时长）与 `published`（发布时间）**只写核实过的值**——时长取自频道 / 播放列表页，发布时间取自频道 RSS；查不到就不写，页面与结构化数据会自动省略。
- `summary` 80–150 字、正文至少两段导读 + 一个「看点」列表，**自己写**，不要翻译官方简介。没看过的内容不要写成确定的结论，用「按官方简介」「以视频内容为准」之类的说法。
- `chapters` 只收录作者在视频简介里给出的时间点（标题可以翻译）。

**最小模板**

```json
---
{
  "title": "中文标题（4–40 字）",
  "originalTitle": "与 oEmbed 返回完全一致的原标题",
  "summary": "80–150 字的原创导读……",
  "provider": "youtube",
  "videoId": "vLIDHi-1PVU",
  "channel": { "name": "Anthropic", "url": "https://www.youtube.com/@anthropic-ai" },
  "categories": ["ai-coding"],
  "tags": ["claude-code"],
  "duration": "12:04",
  "published": "2025-09-26T19:48:00+00:00",
  "chapters": [{ "t": "0:20", "label": "设计原则" }],
  "relatedTools": ["claude-code"],
  "lastChecked": "2026-10-25",
  "order": 25
}
---

<p>导读第一段……</p>
<p>导读第二段……</p>
<h3>看点</h3>
<ul><li>……</li><li>……</li></ul>
```

- `categories`：`ai-coding`（AI 编程）· `gamedev`（游戏开发）· `indie`（独立游戏）· `tutorial`（教程），可多选，第一个是主分类（决定面包屑和分类页里的排序）。新增分类改 `src/lib/videos.ts` 的 `VIDEO_CATEGORIES`。
- `relatedTools` / `relatedApps`：相关的 `/ai/<slug>/` 与 `/apps/<slug>/`（单元测试检查都存在）。
- `owner: true`：站长本人的视频，显示在列表顶部的「我的视频」区（没有这类视频时整个区不显示）。
- 哔哩哔哩：`"provider": "bilibili"`、`"videoId": "BV……"`。facade 已支持；**第一次加 B 站视频时**要在 `vercel.json` 的 `frame-src` 加 `https://player.bilibili.com`，并手动准备缩略图（`scripts/check-csp.mjs` 与单元测试会提醒）。

**缩略图与核对**：新增或更新视频后运行

```bash
node scripts/videos/sync.mjs          # oEmbed 核对（仍存在、可嵌入、标题 / 频道一致）+ 生成缺失的缩略图
node scripts/videos/sync.mjs --check-only   # 只核对（每周内容检查用，T9.2）
```

缩略图生成到 `public/videos/thumbs/<slug>-{480,960}.{avif,webp}`（16:9）。页面只用本地文件，不热链平台图片。

**隐私 facade**：详情页首屏只有本地缩略图和一个指向原平台的链接，点击之前**不向视频平台发任何请求**（不预连接、不加载脚本）；点击后才插入 `youtube-nocookie.com`（隐私增强模式）的播放器。没有 JavaScript 时点击就是普通链接，在 YouTube 打开。

**站长待补**：仓库、V72 站点数据（`legacy/`、`/workspace/projects-azsou`）里都没有找到站长本人的视频或 B 站 / YouTube 频道地址（V72 页脚的「Bilibili / YouTube」图标没有链接）。有自己的视频时，按上面的模板新建文件并写 `"owner": true` 即可，「我的视频」区会自动出现。

## 7. 本地预览与检查

```bash
npm run dev                 # http://localhost:4321/apps/<slug>/
npm run check               # 类型与 schema 检查（字段写错会在这里报）
npm run test:unit           # 内容完整性：图标 / 截图文件存在、直链有 SHA-256、示意图已标注……
```

E2E 测试用的夹具应用在 `src/content/apps/_e2e/`，只有设置 `AZ_E2E_FIXTURES=1` 的构建才会加载（CI 用），**不要**把真实应用放进这个目录。
