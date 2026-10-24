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
- **示意图必须标注**：生成的界面示意（不是真实截图）要写 `"illustrative": true`，页面会显示「示意图 · 非真实截图」。
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

- 没有 `url` 的平台显示「暂未提供」，不会出现可点的下载按钮。
- 所有下载按钮都先到中转页 `/go/<slug>/<os>/`：显示目标域名、SHA-256 与校验命令，点击「继续前往」时记一次真实下载（同一访客 24 小时内只计一次，爬虫不计），然后跳到 `url`。
- 生成 SHA-256：Windows `certutil -hashfile 文件名 SHA256`；macOS / Linux `shasum -a 256 文件名`。把 64 位十六进制填进 `sha256`。
- 访客打开详情页时，页面会按设备自动把最合适的平台设为主按钮（同系统优先，其次网页版 / 扩展 / 命令行）。

## 5. 图标与截图

**图标**：放 `public/apps/icons/<slug>.png`（或 `.svg` / `.webp`），1024×1024，不要自带圆角和阴影。
替换占位图标后把 `icon.placeholder` 改成 `false`，并从 `ownerTodo` 里删掉「图标」那一条。

**截图**：放 `public/apps/screens/<slug>/<名字>.png｜webp｜jpg`，然后在档案里写：

```json
"screenshots": [
  { "src": "/apps/screens/my-tool/main.webp", "alt": "主界面：……", "device": "desktop", "width": 1600, "height": 1000 },
  { "src": "/apps/screens/my-tool/phone.webp", "alt": "手机上的……", "device": "phone", "width": 1179, "height": 2556 }
]
```

- `width` / `height` 写图片的真实像素（页面用它预留位置，避免加载时跳动）。
- `device`：`desktop` / `tablet` / `phone`。
- `alt` 写清楚截图里是什么（给读屏用户和搜索引擎）。
- 建议 WebP，单张 ≤ 300 KB。
- 生成的界面示意图写 `"illustrative": true`（页面显示「示意」角标；不会写进结构化数据的 `screenshot`）。
  FableMotion 目前的 3 张就是示意图（`public/apps/screens/fablemotion/*.svg`），拿到真实截图后替换。

## 6. 站长待补清单（2026-10-24 迁移时）

8 个应用都只有 V72 目录里的信息，以下素材需要站长提供（每个应用的 `ownerTodo` 里也写了）：

| 应用              | 平台（迁移时推断） | 还缺                                                           |
| ----------------- | ------------------ | -------------------------------------------------------------- |
| FableMotion       | 网页版 / Windows   | 真实图标、真实截图（替换 3 张示意图）、下载地址、许可 / 价格   |
| Image Atlas Pro   | 浏览器扩展（商店） | 确认平台与渠道、真实图标、截图、商店链接、许可 / 价格 / 隐私   |
| Capture Kit       | 浏览器扩展         | 确认平台与渠道、真实图标、截图、下载地址、许可 / 价格 / 隐私   |
| 单文件工具箱      | 网页版（直链）     | 真实图标、截图、下载地址 + SHA-256、许可 / 价格                |
| 程序化声场        | 网页版             | 真实图标、截图、在线地址、许可 / 价格                          |
| 职业技能树工具    | 网页版（推断）     | 确认平台、真实图标、截图、地址、许可 / 价格                    |
| Sub2API           | 命令行（推断）     | 确认平台与渠道（GitHub Release？）、图标、截图、许可、隐私说明 |
| Hermes 回归验收器 | 网页版（直链）     | 真实图标、截图、下载地址 + SHA-256、许可 / 价格                |

## 7. 本地预览与检查

```bash
npm run dev                 # http://localhost:4321/apps/<slug>/
npm run check               # 类型与 schema 检查（字段写错会在这里报）
npm run test:unit           # 内容完整性：图标 / 截图文件存在、直链有 SHA-256、示意图已标注……
```

E2E 测试用的夹具应用在 `src/content/apps/_e2e/`，只有设置 `AZ_E2E_FIXTURES=1` 的构建才会加载（CI 用），**不要**把真实应用放进这个目录。
