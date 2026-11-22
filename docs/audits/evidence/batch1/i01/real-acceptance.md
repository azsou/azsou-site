# I01（b）真实链路验收清单——状态：**阻塞（未执行）**

> 这一层才是 I01 / T046 / T074 的验收。（a）官方测试密钥回归（`tests/db/i01-official-keys.test.ts`）**不能**当作真实验收。
> 脚本：`scripts/i01/real-acceptance.mjs`。**退出码（2026-10-28 第五轮）：只有 7 个预期用例全部执行且通过才是 0**；1 = 失败 / 人工证据不合格；2 = 前提缺失或目标不在允许清单（不发任何请求）；3 = 有用例阻塞（BLOCKED）或部分运行。旧版在只有阻塞时也退出 0，已修（`tests/unit/i01-runner.test.ts`）。当前输出见 [real-acceptance-blocked.txt](real-acceptance-blocked.txt)。
> 收件箱只能人工收信 → 真实邮件确认、真实 Turnstile 成功路径、GitHub OAuth、T074 用**人工证据**完成，产物与通过条件见 [manual-evidence.md](manual-evidence.md)。
> 目标只能是 azsou-test（`ovvfwkmqlejcpatmfqcd`，`scripts/supabase-env.mjs` 测试项目允许清单）；生产、清单外项目、本机栈一律拒绝。证据只记状态码 / 错误码 / 跳转目标的源与路径，不记密码、cookie、token、密钥、邮件正文。

## 前提（全部缺失）

| #   | 需要                                                                                                                                                                          | 由谁提供                    | 环境变量                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | 隔离的 Supabase 测试项目（与生产完全分开），Auth 设置：Site URL = 测试预览站；Redirect URLs 只有 `<预览站>/auth/callback/**`                                                  | 站长 / 测试项目负责人       | `I01_SUPABASE_URL`、`I01_SUPABASE_ANON_KEY`、`I01_CONFIRM_ISOLATED=1`                                  |
| 2   | 指向该测试项目的测试预览部署（`/api/auth` 服务端守卫可用）                                                                                                                    | 站长（Vercel 预览环境变量） | `I01_SITE_URL`（唯一部署地址）+ `I01_CANDIDATE_SHA` + `I01_GITHUB_DEPLOYMENT_ID`（执行器只读核对绑定） |
| 3   | 可程序读取的测试收件箱（专用域名 + HTTP API，或 IMAP 网关）；测试项目 SMTP 指向能投递到它的发件服务                                                                           | 站长                        | `I01_INBOX_API`、`I01_INBOX_TOKEN`、`I01_INBOX_DOMAIN`                                                 |
| 4   | GitHub OAuth 测试应用（client id / secret 配在测试项目 Auth → Providers → GitHub，回调为测试项目 `/auth/v1/callback`）+ 一个专用、无权限的 GitHub 测试账号                    | 站长                        | `I01_GITHUB_TEST_LOGIN`、`I01_GITHUB_TEST_PASSWORD`                                                    |
| 5   | 真实 Turnstile 站点（sitekey 配在预览站 `PUBLIC_TURNSTILE_SITE_KEY`，secret 配在预览站 `TURNSTILE_SECRET_KEY`，若测试项目也开验证码则同一 secret 配到 Auth → Bot Protection） | 站长                        | `I01_TURNSTILE_EXPECT_REAL=1`                                                                          |
| 6   | 测试项目 Auth → Rate Limits 的当前数值（限流步骤按它计算触发次数）                                                                                                            | 站长                        | —                                                                                                      |

## 步骤（对应 T046 / T074 原文）

| 步骤   | 内容                                                                                                                                                                                                                                                                                          | 自动化                                                               | 通过标准                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T046-1 | 注册 → 真实确认邮件 → 链接回 `/auth/callback/` → 会话；同一链接第二次使用                                                                                                                                                                                                                     | 脚本                                                                 | 第一次跳回本站回调页并带会话；第二次不带会话（被拒）                                                                            |
| T046-2 | 找回密码 → 真实 recovery 邮件 → 只能用一次；用 recovery 会话设新密码后，旧密码登录必须 400、新密码 200（第七轮）                                                                                                                                                                              | 脚本                                                                 | 同上 + 旧密码被拒、新密码可用                                                                                                   |
| T046-3 | redirect 白名单：`https://evil.example/`、`<站>/auth/callback/..//evil.example`、`//evil.example/`                                                                                                                                                                                            | 脚本                                                                 | 邮件里的链接最终都落在本站源                                                                                                    |
| T046-4 | 伪造 token + **真实过期 token**（`I01_EXPIRED_ACCESS_TOKEN_FILE`，azsou-test 真实签发、`exp` 已过、role authenticated，0600）+ 第八轮**有效期内被接受记录**（`I01_EXPIRED_TOKEN_ACCEPTED_FILE`，`--capture-token` 在 exp 前生成）：`/auth/v1/user`、`/auth/v1/verify`；缺 token 或记录 → 阻塞 | 脚本                                                                 | 有效期内 200（同一 sha256 / sub）；过期后 401/403 且原因明确是 `token is expired`（错签名的 `bad_jwt` 不算）；verify 不换出会话 |
| T046-5 | Turnstile 真实密钥：失败路径（测试 token 打真实 secret → `/api/auth` 400）由脚本跑；成功路径（真实浏览器完成挑战 → 「查收确认邮件」）与限流（超过「每小时邮件数」→ 429 `over_email_send_rate_limit`）需要浏览器步骤                                                                           | 半自动                                                               | 失败被拒；成功可注册；限流生效且提示可恢复                                                                                      |
| T046-6 | GitHub OAuth：授权 → PKCE 回调 → 会话 → 跳回 `next`；重放同一 `?code`、伪造 state、缺 code_verifier                                                                                                                                                                                           | 浏览器（条件齐备时新建 `tests/e2e-real/oauth.spec.ts`，不进常规 CI） | 正常流程最终 `page.url()` 源为本站；三种异常都显示「链接无法使用」                                                              |
| T074   | 在测试项目上重放上述回调参数（过期、重复、错 state / PKCE、外域 `next`，外域 `next` 用 `scripts/i01/redirect-vectors.mjs` 全表 42 条，人工证据逐条给出实际落点，报告逐条列「期望 / 实际」）                                                                                                   | 脚本 + 浏览器                                                        | 39 个外域向量落到本站 `/`；3 条合法点段落到规范化路径；不泄露 token                                                             |

执行：`I01_CONFIRM_ISOLATED=1 … node scripts/i01/real-acceptance.mjs`，报告写到 `test-results/i01-real/report.json`，脱敏后附到本目录。

## 第七轮（2026-10-29）：稳定域名映射、通道隔离

- **稳定候选域名保留**：`I01_SITE_URL` 可以是候选分支的稳定 Vercel 域名（不硬拒、不加更宽的通配、不改 Auth / Turnstile 配置）。
  验收前后各记录一次「域名 → Vercel 部署 id → SHA → 候选分支头」（`scripts/i01/mapping.mjs`，只读）；开始前候选分支头必须 = 候选 SHA，**验收期间冻结候选推送**；映射有任何变化 → 证据作废（退出码 3）。
- **管理通道与用户验收通道隔离**（`scripts/i01/channels.mjs`）：沙箱出口代理在 azsou-test 项目主机上注入并覆盖 `Authorization`（来源不明，见
  `docs/audits/evidence/sbtest/credential-binding-2026-10-29.md`）。用户 / anon / 封禁 / RLS 验收只走直连用户通道（不经全局 fetch、不读 `*_PROXY`，
  只允许 anon key 与用户 JWT，拒绝 service_role / `sb_secret_`），第一次请求前金丝雀必须 401 / 403；GitHub / Vercel 只读查询走管理通道。
- **仍未执行**：真实邮件（T046-1/2/3）、限流（T046-5）、真实过期 token、重置后旧 / 新密码——代码与离线测试已就绪（`tests/unit/i01-r7.test.ts`），真实环境未跑。
