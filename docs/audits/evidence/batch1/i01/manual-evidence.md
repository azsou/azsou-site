# I01 真实链路验收：人工证据清单（azsou-test）

> 收件箱目前只能人工收信（没有可程序读取的 API），GitHub OAuth 授权与真实 Turnstile 挑战也需要真人操作，所以这些用例用**人工证据**完成，
> 再由 `scripts/i01/real-acceptance.mjs --manual-evidence=<目录>` 逐项校验。脚本不会把阻塞（BLOCKED）或未执行记为通过：
> **只有 7 个预期用例（T046-1…T046-6、T074）全部执行且通过，退出码才是 0**（1 = 失败 / 证据不合格，2 = 前提缺失或目标不在允许清单，3 = 阻塞或部分运行）。

## 前提

- 只在隔离测试项目 **azsou-test（`ovvfwkmqlejcpatmfqcd`）** 和指向它的测试预览站上做；生产项目、生产站点、本机栈一律被脚本拒绝（退出码 2）。
- 预览站必须是**锁定候选 SHA** 的构建（完整 40 位 SHA 写进 `manifest.json` 的 `candidate_sha`），部署前后按 `docs/DEPLOY.md`「Supabase 连接配置」核对前后端都指向 azsou-test。
- **部署绑定（第六轮 ⑤）**：执行器在发出任何验收请求之前，用只读 GitHub Deployments API 核对 `I01_GITHUB_DEPLOYMENT_ID`：sha = `I01_CANDIDATE_SHA`、environment = Preview、创建者 vercel[bot]、当前状态 success、environment_url 的源 = `I01_SITE_URL`（必须是该部署的**唯一地址**，分支别名 `*-git-*` 会随新推送漂移 → 拒绝）；给了 `I01_VERCEL_DEPLOYMENT_ID`（`dpl_…`）时它必须出现在该部署的状态里。任何一项不符 → 退出码 2。`manifest.json` 的 `candidate_sha` 必须等于 `I01_CANDIDATE_SHA`，否则证据不合格（1）。
- 测试账号全部用 `@example.com` 以外、能人工收信的专用收件箱；GitHub 用专用、无权限的测试账号。

## 目录结构

```
<证据目录>/
  manifest.json
  T046-1-inbox-confirmation.png   …（文件名随意，必须在目录内，清单里写相对路径 + sha256）
```

`manifest.json`：

```json
{
  "project_ref": "ovvfwkmqlejcpatmfqcd",
  "site_origin": "https://<预览站>.vercel.app",
  "candidate_sha": "<40 位提交 SHA>",
  "operator": "<执行人>",
  "deployment_mapping": {
    "before": {
      "domain": "<稳定候选域名或唯一地址的主机名>",
      "vercel_deployment_id": "dpl_…",
      "sha": "<40 位>"
    },
    "after": { "domain": "…", "vercel_deployment_id": "dpl_…", "sha": "<40 位>" }
  },
  "steps": {
    "T046-1": {
      "result": "pass",
      "performed_at": "2026-10-29T10:00:00+08:00",
      "artifacts": [
        {
          "kind": "inbox-confirmation",
          "path": "T046-1-inbox-confirmation.png",
          "sha256": "<sha256sum 输出>"
        }
      ],
      "observations": {
        "verify_redirect_origin": "https://<预览站>.vercel.app",
        "verify_redirect_path": "/auth/callback/",
        "session_established": true,
        "replay_rejected": true
      }
    }
  }
}
```

脚本校验：顶层四个字段 + `deployment_mapping.before / after`（第七轮：执行人在开始前、结束后各记录一次「域名 → Vercel 部署 id → SHA」，必须都等于脚本自己记录的映射；不一致 = 期间换了部署 → 判失败）；每个产物存在、非空、在目录内、sha256 一致、`.png/.jpg` 是真图片、格式只能 png / jpg / har / json / txt；`performed_at` 不在未来且不超过 30 天；每个观测值满足下表的通过条件；`result` 为 `fail` 直接判失败。

## 每个用例必须提供的产物与观测值

| 用例   | 产物（kind）                                                                                                                                                                                                    | 观测值 → 通过条件                                                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T046-1 | `inbox-confirmation` 确认邮件截图（token 打码）；`callback-signed-in` 落在 `/auth/callback/` 再到已登录（地址栏可见）；`replay-rejected` 重放被拒                                                               | `verify_redirect_origin` = 预览站源；`verify_redirect_path` = `/auth/callback/`；`session_established` = true；`replay_rejected` = true                                                                                                                                                                                                                                |
| T046-2 | `inbox-recovery`；`recovery-landing`；`replay-rejected`                                                                                                                                                         | `verify_redirect_origin` = 预览站源；`new_password_login_ok` = true；`old_password_rejected` = true（第七轮：重置后旧密码登录 400）；`replay_rejected` = true                                                                                                                                                                                                          |
| T046-3 | `inbox-redirect-vectors` 三封恶意 `redirect_to` 的邮件；`landing-origins` 三个落点                                                                                                                              | `landing_origins` = 3 个且都等于预览站源                                                                                                                                                                                                                                                                                                                               |
| T046-4 | `forged-token-responses`（截图或 HAR；也可由脚本自动跑）；`expired-token-lifecycle`（第八轮：同一个真实 token 的两段记录——有效期内 `/auth/v1/user` 200、过期后 401/403 的正文，token 打码只留 sha256 前 12 位） | `user_status` ∈ {401, 403}；`verify_session_issued` = false；`expired_user_status` ∈ {401, 403}；`expired_reason_is_expiry` = true（正文原因明确是 `token is expired`；**错签名 / 解析错误的 `bad_jwt` 不算过期**）；`accepted_before_exp_status` = 200（同一 token 在 exp 之前被 azsou-test 接受）                                                                    |
| T046-5 | `turnstile-widget-passed` 真实挑战通过；`register-success`「查收确认邮件」；`inbox-confirmation`；`fake-token-rejected`；`rate-limited`                                                                         | `turnstile_real_key` = true；`register_api_status` = 200；`fake_token_status` = 400；`rate_limit_status` = 429                                                                                                                                                                                                                                                         |
| T046-6 | `github-consent`（azsou-test 的 OAuth 应用）；`final-signed-in`（回到 `/forum/` 已登录）；`code-replay-rejected`；`bad-state-rejected`                                                                          | `final_origin` = 预览站源；`final_path` = `/forum/`；`code_replay_rejected` = true；`bad_state_rejected` = true                                                                                                                                                                                                                                                        |
| T074   | `callback-replay-table`（`tests/redirect-vectors.ts` 全表执行记录）                                                                                                                                             | `vectors_total` = 全表条数（`scripts/i01/redirect-vectors.mjs` 的 `allVectors()`，当前 42）；`vectors_executed` = 全表每条恰好一次；`vectors_rejected_or_idempotent` = `vectors_total`；`offsite_navigations` = 0；**`vectors`** = 42 条 `{input, landed_origin, landed_path}`（第七轮：逐条期望 vs 实际，外域向量必须落到 `/`，3 条合法点段必须落到规范化路径，见下） |

### T074 逐条落点（第七轮）

`vectors` 每条一个对象，`landed_path` 含查询串。期望落点由脚本按 `scripts/i01/redirect-vectors.mjs` 计算（`expectedLanding`）：39 个外域 / 绕过向量 → 预览站源 + `/`；
3 条合法点段 → `/a/../forum/` → `/forum/`、`/./articles/` → `/articles/`、`/forum/./new/?cat=tech` → `/forum/new/?cat=tech`。报告 `results[T074].vectors` 列出 42 行「期望 / 实际 / 是否一致」。

### 稳定候选域名与冻结（第七轮）

`I01_SITE_URL` 可以是稳定的候选域名（Vercel 分支别名）。脚本在任何验收请求之前与全部用例之后各查一次（只读 Vercel / GitHub API）：
域名 →（别名）→ Vercel 部署 id → 部署的 githubCommitSha → 候选分支头。开始前必须：部署 READY、sha = `I01_CANDIDATE_SHA`、**候选分支头 = `I01_CANDIDATE_SHA`**；
验收期间**不得向候选分支推送**；前后两次有任何不同 → 本次证据作废（退出码 3）。Vercel 团队项目需 `I01_VERCEL_TEAM_ID`。不改 Auth 的 Site URL / Redirect URLs 通配、不改 Turnstile。

### 用户验收通道（第七轮）

测试项目、预览站、收件箱的请求只走 `scripts/i01/channels.mjs` 的直连用户通道：不经全局 fetch、不读 `*_PROXY`，请求头只能有 anon key 与用户自己的 JWT；
第一次请求前的金丝雀（只带 anon 读 `GET /auth/v1/admin/users?per_page=1`）必须是 401 / 403，否则所有自动用例阻塞。GitHub / Vercel 的只读查询走管理通道（可经注入）。

## 执行

```bash
I01_CONFIRM_ISOLATED=1 I01_SUPABASE_URL=https://ovvfwkmqlejcpatmfqcd.supabase.co I01_SUPABASE_ANON_KEY=<publishable> \
I01_SITE_URL=https://<稳定候选域名或唯一地址> I01_CANDIDATE_SHA=<40 位> I01_GITHUB_DEPLOYMENT_ID=<id> [I01_VERCEL_DEPLOYMENT_ID=dpl_…] \
[I01_VERCEL_TEAM_ID=team_…] [I01_EXPIRED_ACCESS_TOKEN_FILE=<0600 文件>] \
  NODE_USE_ENV_PROXY=1 node scripts/i01/real-acceptance.mjs --manual-evidence=<证据目录>   # 管理通道：I01_GITHUB_TOKEN 或线路注入；用户通道永远直连
echo $?   # 只有 0 才算 I01 真实链路验收通过
```

报告 `test-results/i01-real/report.json` 的 `summary` 列出预期数、执行数、通过 / 失败 / 阻塞 / 未执行的用例。退出码测试：`tests/unit/i01-runner.test.ts`。

**状态（2026-10-29）：未执行。** 真实邮件、限流、真实过期 token、重置后旧 / 新密码都已实现，未在真实环境执行。 预览站未按锁定候选 SHA 部署（需站长批准），人工证据尚未采集。

### T046-4 真实过期证据（第八轮）

GoTrue 对过期 token 与错签名 token **都**回 `error_code: bad_jwt`，区别只在 `msg`（`… token is expired` 与 `… signature is invalid`）。所以「被拒 + bad_jwt」不能证明过期检查生效。
脚本与人工证据都要三段证据，缺一段就不算通过（脚本缺记录 → 阻塞）：

1. **真实来源**：token 由 azsou-test 签发（`iss` = `https://ovvfwkmqlejcpatmfqcd.supabase.co/auth/v1`，`role` = authenticated），来自真实登录（不是手工伪造 / 本地签名）。
2. **有效期内被接受**：在 `exp` 之前运行 `node scripts/i01/real-acceptance.mjs --capture-token=<0600 token 文件> --capture-out=<记录路径>`（只读、用户直连通道），
   `/auth/v1/user` 必须 200 且返回的 id = token 的 `sub`；记录（0600，只存 token 的 sha256）给 `I01_EXPIRED_TOKEN_ACCEPTED_FILE`。
3. **过期后因过期被拒**：`exp` < 现在 − 60 秒；同一个 token（sha256 与记录一致）调 `/auth/v1/user` → 401/403，且正文原因明确是过期（`isExpiryRejection`：含 `token is expired` / `token has expired` / `JWT expired`，且不含签名 / 畸形错误）。

用户直连通道不可用（DNS / 连接被拒 / 超时）→ 整个验收停止、记为阻塞，**绝不**回退到管理通道或出口代理；不重试。不做真实注册 / 发信 / OAuth / 限流；没有真实证据不记通过。
