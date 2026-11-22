# /apps/ JS 预算（49,152 B）——前后台共享依赖拆分前后

口径与 lighthouserc.cjs 的 `resource-summary:script:size` 相同：/apps/ 页面加载期间（含 load 后空闲时加载的 island）全部脚本响应的传输字节（gzip 正文 + 响应头），
同一个服务器 `scripts/serve.mjs`，Lighthouse 移动档视口。测量用 `tests/e2e/js-budget.spec.ts`（本地 chromium，2026-10-27）。

| 构建                                                                | 数据层共享 chunk（index.*.js，传输字节） | /apps/ 合计                                  | 余量      |
| ------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | --------- |
| 整合候选 `20e235e`（#4 f633030 + #5 + #6，拆分前）                  | 18,842                                   | **49,229**（与 CI Lighthouse 一致，超 77 B） | −77       |
| #4 `a93d37f` 单独（拆分前）                                         | 18,244                                   | 48,179                                       | 973       |
| #4 本轮单独（拆分后）                                               | 14,665                                   | 44,600                                       | 4,552     |
| 本地重合并 #4 本轮 + #5 `7def319` + #6 `8af9b55`（scratch，未推送） | 14,665                                   | **45,058**                                   | **4,094** |

拆分后数据层 chunk 只含 `src/lib/data/{session,types,memory,supabase-auth,supabase,index}.ts` 与 `src/lib/images.ts`；
#5 新增的后台代码（批量结果、幂等键、越界分页等，都在 `src/lib/data/admin.ts` / `admin-crm-api.ts` / `src/scripts/admin/`）随之只进后台包，
合并后数据层 chunk 字节数与 #4 单独时相同——**#5 不需要为预算改任何模块**。
其余增量来自 #6 的公开页面脚本（catalog / list-shell / Base / user-menu 等，合计约 +460 B），在预算内。

构建门禁 `tests/built/js-budget.test.ts`：a93d37f 上 3/3 失败（[built-test-before-a93d37f.txt](built-test-before-a93d37f.txt)），拆分后本分支与重合并构建均 3/3 通过。
