# I01（T046 / T074）执行记录——2026-10-27（第 3 轮更新 2026-10-28）

## 第 3 轮（站长 2026-10-28 02:43 拍板）：两层分开

| 层                    | 是什么                                                                                                                                                                                                                                                                 | 状态               | 在哪                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| （a）官方测试密钥回归 | 只用公开的官方测试凭据：Cloudflare Turnstile 官方测试 secret（真实请求 Cloudflare siteverify：总是通过 / 总是失败 / token 已用过）+ Supabase Auth（GoTrue v2.197.0 官方二进制）跑在本地 Postgres；通过与失败两条路径都断言。CI 的 db 任务（`npm run test:db`）自动执行 | 17/17 通过（本地） | `tests/db/i01-official-keys.test.ts`、`tests/db/gotrue.ts`                  |
| （b）真实链路验收     | 隔离 Supabase 测试项目 + 真实收件箱 + GitHub OAuth 测试应用 + 真实 Turnstile 密钥                                                                                                                                                                                      | **阻塞，未执行**   | [real-acceptance.md](real-acceptance.md)、`scripts/i01/real-acceptance.mjs` |

**（a）不是真实验收**：GoTrue 是本地实例、Turnstile 用的是官方测试密钥（Cloudflare 对测试密钥固定返回结果），证明的是站点代码与 GoTrue 的判断逻辑，不证明真实项目的配置、邮件投递与 OAuth 应用。

（a）覆盖：siteverify 三种官方 secret；站点 `/api/auth` 守卫 → 真实 siteverify → 本地 GoTrue（通过时建出用户，失败 / 已用过 / 缺 token 时 GoTrue 收不到注册）；GoTrue 自带 Turnstile 的通过 / 失败 / 已用过 / 缺 token；GoTrue redirect 白名单（外域、点段回落到 Site URL）；魔法链接只能用一次；密码错误；refresh token 重放（紧接着重用上一个 = 安全幂等，轮换后再用旧 token = `refresh_token_already_used` 并吊销整条链）；过期 / 伪造签名 JWT 被拒（`bad_jwt`）。
未覆盖（在（b））：真实邮件投递与链接、GitHub OAuth、真实 Turnstile 成功挑战、Supabase 云端限流。

### safeNext 第 3 轮（点段规范化绕过）

修复前 `/.//evil.example`、`/a/..//evil.example`、`/%2e//evil.example`、`/..//evil` 等经 URL 解析后路径为 `//evil.example`，safeNext 原样返回 → `location.assign` 跳外域。
向量表 `tests/redirect-vectors.ts`（39 个：点段、编码点 / 斜杠 / 反斜杠、二次 / 三次编码、反斜杠混用、编码控制字符 + 第 1 轮的制表符 / 换行），单测与 e2e 共用。

| 检查                                              | 修复前                                                                                                                                                                | 修复后                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `safeNext` 单测（39 向量）                        | 27 个未被拒，其中 9 个直接返回 `//evil…`（[safe-next-r3-before.txt](safe-next-r3-before.txt)）                                                                        | 0                                                   |
| e2e：回调页 magiclink 全表                        | 27 失败：11 个落到外站（含 2 个经测试静态服务器 308 离站），15 个停在带编码分隔符的站内路径、1 个停在浏览器错误页（[t074-r3-e2e-before.txt](t074-r3-e2e-before.txt)） | 0（[t074-r3-e2e-after.txt](t074-r3-e2e-after.txt)） |
| e2e：回调页 signup、`/login/?next=` 密码登录 全表 | （同一实现，未单独留修复前日志）                                                                                                                                      | 0                                                   |
| 测试静态服务器补尾斜杠 `/%2F/evil.example`        | 308 → `//evil.example/`（离站）                                                                                                                                       | 308 → `/%2F/evil.example/`（本站）                  |

修复：`src/lib/safe-next.ts` 用 `new URL(next, origin)` 解析，要求同源且规范化路径不以 `//`、`/\` 开头，返回规范化的 路径+查询+锚点；反复解码（≤4 层）后任何一层出现控制字符 / 空白 / 反斜杠 / 编码的 `.` `/` `\` 一律拒绝。
最终导航同源校验：`navigateSameOrigin()`——登录后 `afterSignIn`、回调页 `location.replace`、首页旧 hash 跳转都改走它。
其余 redirect / Location 汇点排查：服务端 `/api/auth` 的 `safeRedirect`（本来就按 URL 解析同源 + `/auth/callback/` 前缀，补了点段单测，未改）；`scripts/serve.mjs` 补 / 去尾斜杠（已修，`scripts/lib/slash-redirect.mjs`）；CMS OAuth（目标固定为 github.com 授权页，不含用户输入）；`vercel.json` redirects（目标固定）；其余 `location.assign` 的目标都是代码生成的站内路径（通知链接经 `url.forumThread` 正则 / 编码、后台表格视图只换查询串、命令面板为固定条目），不含外部输入。
线上 Vercel 对编码斜杠的补尾斜杠行为未实测（只在测试服务器上验证，生产不碰）；站内路径已不会产出编码斜杠，next 中出现即拒绝。

---

站长 21:06：「I01 按原 T046/T074 执行」。原文出自交接 PR #3（分支 `docs/hark-handoff-2026-10-27`，head `e65fcae`）。

## 原始定义（逐字）

`docs/audits/2026-10-27-hark-handoff.md`：

> ### I01 | P0 | 验收真实Auth、OAuth、验证码和邮箱链路
>
> - 证据类型：真实集成待验证。依赖：B03。
> - 实施：隔离环境走真实注册确认/密码找回/GitHub回调/PKCE/Turnstile成功失败与限流；不可只用mock。
> - 验收：每条链路有真实服务证据；过期/重复token/错误redirect被拒；不在报告暴露密码、cookie或密钥。
> - 用例：T046, T074。来源：[AUTH_TEST]、[DEPLOY]。

`docs/audits/2026-10-27-test-plan.md`：

> ### T046 | P0 | Auth/OAuth/Turnstile完整链
>
> - 关联：I01。层级：真实集成。
> - 前提：真实测试服务及收件箱。
> - 步骤：注册确认、找回、OAuth回调、验证码成功/失败、过期token。
> - 预期：链路可用且失败可恢复；redirect白名单生效；证据脱敏。

> ### T074 | P0 | OAuth/邮件回调重放和错误redirect
>
> - 关联：I01。层级：安全。
> - 前提：过期、重复、错state/PKCE、外域next。
> - 步骤：只在测试项目重放回调参数。
> - 预期：请求被拒或安全幂等；不泄露token、不跳任意外域。

## 解读

两层，都要有，不能互相替代：

1. **站点自己的判断**（前端回调页 + `/api/auth` 服务端守卫）：外域 / 伪装 next、PKCE 授权码重放、没有发起过的登录、伪造或过期 token、出错时清掉地址栏。
   这些不依赖第三方，可以在本地先做失败优先；GoTrue 用假实现，**只算回归层，不算 I01 验收**。
2. **真实服务链路**（T046 全部步骤 + T074 在真实测试项目上重放）：真实 Supabase Auth 发确认 / 找回邮件到授权测试收件箱、真实 GitHub OAuth 应用回调、
   Turnstile 测试密钥的成功 / 失败（Cloudflare 官方测试 sitekey / secret）与限流、过期 / 重复 token 被 GoTrue 拒绝、redirect 白名单（Supabase Auth 的 Redirect URLs）。
   必须在隔离的 Supabase 测试项目上做（绝不碰生产项目）。

## 本 PR 完成的部分（第 1 层）

`tests/e2e/auth.spec.ts`「T074 回调重放与错误 redirect（本地回归层）」12 例 + `tests/unit/safe-next.test.ts` 3 例：

| 检查                                                                                                                                  | 修复前                                            | 修复后 |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ |
| 外域 next：`//evil.example/x`、`/\evil.example`、`https://evil.example/`、`" //evil.example"`                                         | 通过                                              | 通过   |
| 外域 next：`/<TAB>/evil.example`、`/<LF>/evil.example`、`/<CR><LF>/evil.example`、`/<TAB>\evil.example`（魔法链接与注册确认两种回调） | **5 失败：登录后跳到 evil.example（开放重定向）** | 通过   |
| PKCE 授权码重放（同一 `?code` 第二次打开）                                                                                            | 通过（verifier 用后即清，不再请求换取会话）       | 通过   |
| 未在本浏览器发起的登录（伪造 code / state、缺 code_verifier）                                                                         | 通过                                              | 通过   |
| 伪造 / 过期 access_token（服务端 401）                                                                                                | 通过（错误页，地址栏与本地都不留 token）          | 通过   |

根因：`safeNext` 只看前缀，但浏览器解析 URL 时会删掉制表符 / 换行（WHATWG URL），`/<TAB>/evil.example` 在 `location.replace()` 时变成协议相对地址 `//evil.example`。
修复：`src/lib/safe-next.ts`——控制字符 / 空白 / 反斜杠直接拒绝，再用 URL 解析确认同源，只返回路径 + 查询 + 锚点。日志：[t074-before.txt](t074-before.txt)。
服务端 `/api/auth` 的 `safeRedirect`（只允许本站 `/auth/callback/`）原来就是按 URL 解析判断同源的，单测已覆盖，未改。

## 阻塞（第 2 层，I01 仍未通过）

| 需要                                                                                          | 用途                                                     | 现状                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| 隔离的 Supabase 测试项目（URL + anon key；Auth 设置里 Site URL / Redirect URLs 指向测试预览） | T046 全链路、T074 在真实 GoTrue 上重放                   | 另一负责人在准备；本 PR 没有任何该项目的凭据 |
| 授权测试收件箱（可程序读取，如专用邮箱 + IMAP / 邮件 API）                                    | 注册确认、找回密码邮件里的真实链接；过期 / 重复使用      | 无                                           |
| GitHub OAuth 测试应用（client id / secret 配到测试项目，回调指向测试项目）                    | OAuth 回调、PKCE、错 state                               | 无                                           |
| Turnstile：测试项目与测试预览配 Cloudflare 官方测试密钥（必过 / 必败两组）                    | 验证码成功 / 失败；限流按 Supabase Auth 速率限制设置实测 | 无                                           |
| 能访问上述服务的测试预览部署（或本地 `astro dev` + Vercel 函数）                              | `/api/auth` 服务端守卫走真实 Turnstile / GoTrue          | 无                                           |

条件齐备后按 T046 步骤逐条跑，证据只记录状态码 / 错误码 / 跳转目标，不记录密码、cookie、token 或密钥。
