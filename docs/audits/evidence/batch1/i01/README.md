# I01（T046 / T074）执行记录——2026-10-27

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
