# AdSense / GA4 / Search Console 接入与申请清单（P8）

代码已经全部就位、**默认关闭**：没有设置环境变量时，站点不输出任何 Google 脚本、广告位、`ads.txt`，CSP 保持严格，Lighthouse 不受影响。
本文是站长需要**手动**完成的步骤。开发侧不会替你注册账号、提交站点或申请 AdSense。

政策依据（2026-10-25 核对）：

- AdSense 计划政策：<https://support.google.com/adsense/answer/48182>；新手指南：<https://support.google.com/adsense/answer/23921>
- 欧洲经济区 / 英国 / 瑞士需要 Google 认证 CMP（EEA、英国自 2024-01-16，瑞士自 2024-07-31）：<https://support.google.com/adsense/answer/13554116>
- Consent Mode v2（`ad_user_data`、`ad_personalization`，`region` 参数，默认值必须先于任何 Google 标签）：<https://developers.google.com/tag-platform/security/guides/consent>
- ads.txt：<https://support.google.com/adsense/answer/12171612>
- AdSense 与 CSP（官方只支持 nonce 严格 CSP）：<https://support.google.com/adsense/answer/16283098>

---

## 0. 申请前提（全部满足再申请）

| #   | 条件                                                                                        | 现状（2026-10-25）           |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| 0.1 | 生产站 **azsou.com 已切换到 v2** 并稳定运行（P11 T11.1：迁移 0002→0016、合并 PR #2）        | ❌ 未上线（PR #2 仍是草稿）  |
| 0.2 | 原创长文 ≥ 25 篇（每篇 ≥ 1500 字），见 `docs/CONTENT-PLAN.md`                               | 3 篇长文 + 12 篇 V72 短文    |
| 0.3 | 没有空页面 / 占位内容（构建测试 `tests/built/p8.test.ts` 保证）                             | ✅                           |
| 0.4 | 隐私政策（含 Google 广告 Cookie 说明与停用入口）、Cookie 政策、广告与联盟披露、关于、联系页 | ✅ 中英文各一份，页脚可达    |
| 0.5 | 站点导航清晰、移动端可用、无违规内容（成人、侵权下载、诱导点击等）                          | ✅（第三方软件只链官方渠道） |
| 0.6 | 域名年限：部分地区（含中国大陆）新域名可能要求注册满 6 个月                                 | 站长自行确认                 |
| 0.7 | 申请人年满 18 周岁，Google 账号可接收付款（收款信息、税务信息在 AdSense 后台填写）          | 站长自行确认                 |

## 1. 环境变量（Vercel → Project → Settings → Environment Variables，Production）

| 变量                          | 例子                      | 作用                                                                                      |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_ADSENSE_CLIENT`       | `ca-pub-1234567890123456` | 开启 AdSense：生成 `/ads.txt`、每页输出 `google-adsense-account` meta、广告页加载 AdSense |
| `PUBLIC_ADSENSE_SLOT_ARTICLE` | `1234567890`              | 文内广告单元 ID（长文第 2 个二级标题前）                                                  |
| `PUBLIC_ADSENSE_SLOT_SIDEBAR` | `1234567890`              | 文章侧栏广告单元 ID                                                                       |
| `PUBLIC_ADSENSE_SLOT_LIST`    | `1234567890`              | 文章列表间广告单元 ID（每 6 篇一个）                                                      |
| `PUBLIC_GA4_ID`               | `G-XXXXXXXXXX`            | 开启 GA4（受 Consent Mode v2 约束）                                                       |
| `PUBLIC_GSC_VERIFICATION`     | `abc123…`                 | Search Console「HTML 标记」验证码，只输出首页 meta                                        |
| `PUBLIC_CONTACT_EMAIL`        | `hello@azsou.com`         | 在联系页 / 隐私政策公开的邮箱（不设则只列站内渠道与 GitHub Issues）                       |

格式不对的值会被当作未设置（不输出坏代码）。某个广告位没填单元 ID → 该位置不出广告。

**CSP 必须同步打开**（CSP 是 `vercel.json` 里的静态响应头，不随环境变量变化）：

```bash
npm run csp:google -- on --ads --ga   # 同时用 AdSense 与 GA4；只用 GA4：on --ga
git commit -am "chore: 放开 Google 标签 CSP" && git push
```

忘了这一步时，`npm run build` 的 `prebuild` 检查会让 Vercel 构建失败并提示上面的命令——不会上线一个广告被 CSP 拦截的站。
停用时：删除环境变量，`npm run csp:google -- off`（恢复到与之前逐字一致的严格 CSP）。

## 2. Google Search Console（先做，提交站点地图）

1. 打开 <https://search.google.com/search-console>，添加资源。推荐「网域」资源 `azsou.com`（在域名 DNS 加 TXT 记录验证，覆盖 www 与所有子域）。
   也可以用「网址前缀」资源 `https://azsou.com/` + **HTML 标记**：把 `content="…"` 里的值填到 `PUBLIC_GSC_VERIFICATION`，重新部署后点「验证」。
2. 「站点地图」里提交：`https://azsou.com/sitemap-index.xml` 与 `https://azsou.com/forum/sitemap-threads.xml`。
3. 「网址检查」抽查首页、一篇长文、一个应用页，确认「网址可编入索引」。
4. 必应（<https://www.bing.com/webmasters>，可直接从 GSC 导入）与百度站长平台按需提交同样的两个站点地图。

## 3. GA4（可选）

1. <https://analytics.google.com> → 管理 → 创建媒体资源（时区选 Asia/Shanghai）→ 数据流选「网站」，网址 `https://azsou.com`，复制衡量 ID `G-…` 到 `PUBLIC_GA4_ID`。
2. 「增强型衡量」按需开启；**不要**开启「Google 信号」以外的个性化选项，除非同步更新隐私政策。
3. 数据保留期按需设置（默认 2 个月；隐私政策写的是 Cookie 最长 2 年）。
4. 部署后用 GA4「实时」报告和 Tag Assistant（<https://tagassistant.google.com>）检查：页面加载时先有 `consent default`，再有 `config`。
5. 只开 GA4、没开 AdSense 时：欧洲时区的访客会看到本站的极简同意条（同意前不加载 gtag.js）；开了 AdSense 后改由 Google 认证 CMP 负责。

## 4. AdSense 申请（满足第 0 节后）

1. <https://adsense.google.com> 注册，填写网站 `azsou.com`、收款国家 / 地区。
2. 「网站」→ 添加 azsou.com → 验证方式选 **meta 标记**（或 ads.txt 片段）。把发布商 ID（`ca-pub-…`）填到 `PUBLIC_ADSENSE_CLIENT`，执行第 1 节的 CSP 命令并部署。
   部署后确认：`https://azsou.com/ads.txt` 返回 `google.com, pub-…, DIRECT, f08c47fec0942fa0`；任意页面源码有 `<meta name="google-adsense-account" content="ca-pub-…">`。
3. 点「请求审核」。审核期间（通常几天到几周）保持站点可访问，不要大改结构。
4. **隐私和消息**（必须）：AdSense → 隐私和消息 → 「欧洲法规」消息 → 创建并发布到 azsou.com（语言选中文 + 英文）。
   这是 Google 认证的 CMP（支持 IAB TCF），本站不再另装第三方 CMP。消息由 AdSense 代码加载，只对 EEA / 英国 / 瑞士访客显示，
   并自动与 Consent Mode 对接。可选：「美国州级法规」消息（CCPA 等）。
5. 审核通过后，「广告」→「按广告单元」创建 3 个**展示广告**单元（文内、侧栏、列表），尺寸选「自适应」，
   把单元 ID 分别填入 `PUBLIC_ADSENSE_SLOT_ARTICLE / _SIDEBAR / _LIST`，重新部署。
   **不要开启「自动广告」**：本站只在预留的位置放广告（与下载 / 跳转按钮保持 ≥ 150px、不在法律页 / 表单页 / 首页），
   自动广告会绕过这些规则。加载器只在有广告位的页面加载 AdSense，也是为此。
6. 「屏蔽控制」里按需屏蔽敏感类别（赌博、约会等），与站点调性一致。

### CSP 排查

AdSense 官方只支持基于 nonce 的严格 CSP；本站是纯静态输出，采用通配域名白名单（`scripts/google-csp.mjs`）。
如果上线后广告不显示，打开浏览器开发者工具 → Console，查找 `Refused to load … because it violates the following Content Security Policy directive`：

1. 把被拦的域名加到 `scripts/google-csp.mjs` 对应指令的列表里；
2. `npm run csp:google -- on --ads --ga` 重新生成，`npm test` 里的 `test:csp` 与单元测试会校验格式；
3. 提交部署。长期方案：用 Vercel Edge Middleware 为每个请求注入 nonce，改为 `'strict-dynamic'` 严格 CSP（需要把 Astro 的外链脚本也加上 nonce，工作量较大）。

## 5. 上线后检查（每次改广告配置后）

- [ ] `https://azsou.com/ads.txt` 正确；AdSense「网站」页 ads.txt 状态为「已授权」
- [ ] 长文页（如 `/articles/consent-mode-adsense-prep/`）有「广告」标注的广告位，首页 / 应用页 / 法律页没有
- [ ] 用欧盟 VPN 打开长文页：先看到 Google 同意弹窗；拒绝后只出受限 / 非个性化广告
- [ ] `/cookies/#choices` 能关闭广告与统计 Cookie，刷新后不再请求 `googlesyndication.com`
- [ ] PageSpeed Insights（移动端）长文页分数没有明显下降；CLS 仍为 0
- [ ] 隐私政策「统计与广告」一节已自动变为「本站通过 Google AdSense 展示广告」（由环境变量控制），并在更新日志注明

## 6. 联盟链接与赞助（T8.7）

- 文章 frontmatter：`"sponsoredLinks": ["https://…"]` 列出联盟地址（正文里的对应链接自动加 `rel="sponsored nofollow noopener"`），
  `"disclosure": { "type": "affiliate" }`（或 `{ "type": "sponsored", "sponsor": "赞助方" }`）在文首显示披露标识。
  正文里也可以给单个链接加 `data-sponsored`。没写 `disclosure` 但正文有 `rel="sponsored"` 链接时，自动按「含联盟链接」显示。
- 赞助位：`src/data/sponsors.json`，`enabled: false` 时不输出任何内容。只登记真实签约的赞助方，写明到期日（过期自动隐藏）。
