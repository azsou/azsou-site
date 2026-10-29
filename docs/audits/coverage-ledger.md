# 路由与截图覆盖账本（B02 首版分母，T002）

来源：`npm run build`（`AZ_E2E_FIXTURES` 未设，与 Vercel 构建一致）的 `dist/client/**/*.html`，候选 `2794ccb` / 本批分支（本批没有新增或删除页面）。
逐条清单：[coverage-ledger.csv](coverage-ledger.csv)（`route_id, route, kind, family, in_sitemap, test_ids, result, blocker_or_exemption`）。
后续批次在 CSV 里补视口 / 主题 / 状态 / 截图列，不另起账本。

## 分母（构建产物 HTML 文件 465 个）

| kind                  | 数量 | 说明                                                                            |
| --------------------- | ---: | ------------------------------------------------------------------------------- |
| page                  |  248 | 内容与功能页（含 `/en/` 页面 85 个、论坛静态种子页、账户页、法律页）            |
| tag                   |  120 | `/tags/*` 展开页（与固定基线「120 个 tag 展开项」一致；`/tags/` 索引计入 page） |
| redirect-interstitial |   78 | `/go/*` 平台中转页（与基线 78 一致），单列，不计入内容页分母                    |
| admin                 |   13 | 12 个后台模块 + 用户详情                                                        |
| error-offline         |    3 | 404、500、offline                                                               |
| test-kit              |    3 | `/_kit/*` 组件样张：排除，需站长确认生产是否应生成（待决）                      |

- sitemap（`sitemap-0.xml`）收录 272 条，全部能在产物里找到；产物中不在 sitemap 的 193 条 = 中转、后台、tag、账户 / 错误页等按策略不收录的页面（逐条见 CSV 的 `in_sitemap`）。
- 非 HTML（单独测试，不计入页面）：`rss.xml` ×5、`feed.json`、`apps/catalog.json`、`search-index.json`、`sitemap-*.xml`。
- 动态实例（论坛 UUID 主题、`/u/?id=`、`/admin/users/view/?id=`）每个模板计 1 条，按合成种子状态覆盖，不声称穷尽。
- 与固定基线对账：源码 108 条记录 / 106 个文件是模板与端点数，不是页数；本表以产物为准。

## 本批（批次 1）已处理

| 路由                                                                                                                                    | 用例       | 结果                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------- |
| `/admin/` `/admin/content/` `/admin/users/` `/admin/reports/` `/admin/guestbook/` `/admin/links/` `/admin/subscribers/` `/admin/audit/` | T091       | 本地真实 PostgREST：PASS；真实预览：BLOCKED |
| `/admin/settings/`                                                                                                                      | T092、T095 | 本地真实 PostgREST：PASS；真实预览：BLOCKED |

应测 465 − 已处理 9 = **456 条未处理**（NOT RUN），按批次 3–5 补齐；截图张数不等于页数。
