# I01 真实链路验收：人工证据清单（azsou-test）

> 收件箱目前只能人工收信（没有可程序读取的 API），GitHub OAuth 授权与真实 Turnstile 挑战也需要真人操作，所以这些用例用**人工证据**完成，
> 再由 `scripts/i01/real-acceptance.mjs --manual-evidence=<目录>` 逐项校验。脚本不会把阻塞（BLOCKED）或未执行记为通过：
> **只有 7 个预期用例（T046-1…T046-6、T074）全部执行且通过，退出码才是 0**（1 = 失败 / 证据不合格，2 = 前提缺失或目标不在允许清单，3 = 阻塞或部分运行）。

## 前提

- 只在隔离测试项目 **azsou-test（`ovvfwkmqlejcpatmfqcd`）** 和指向它的测试预览站上做；生产项目、生产站点、本机栈一律被脚本拒绝（退出码 2）。
- 预览站必须是**锁定候选 SHA** 的构建（完整 40 位 SHA 写进 `manifest.json` 的 `candidate_sha`），部署前后按 `docs/DEPLOY.md`「Supabase 连接配置」核对前后端都指向 azsou-test。
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

脚本校验：顶层四个字段；每个产物存在、非空、在目录内、sha256 一致、`.png/.jpg` 是真图片、格式只能 png / jpg / har / json / txt；`performed_at` 不在未来且不超过 30 天；每个观测值满足下表的通过条件；`result` 为 `fail` 直接判失败。

## 每个用例必须提供的产物与观测值

| 用例   | 产物（kind）                                                                                                                                      | 观测值 → 通过条件                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| T046-1 | `inbox-confirmation` 确认邮件截图（token 打码）；`callback-signed-in` 落在 `/auth/callback/` 再到已登录（地址栏可见）；`replay-rejected` 重放被拒 | `verify_redirect_origin` = 预览站源；`verify_redirect_path` = `/auth/callback/`；`session_established` = true；`replay_rejected` = true |
| T046-2 | `inbox-recovery`；`recovery-landing`；`replay-rejected`                                                                                           | `verify_redirect_origin` = 预览站源；`new_password_login_ok` = true；`replay_rejected` = true                                           |
| T046-3 | `inbox-redirect-vectors` 三封恶意 `redirect_to` 的邮件；`landing-origins` 三个落点                                                                | `landing_origins` = 3 个且都等于预览站源                                                                                                |
| T046-4 | `forged-token-responses`（截图或 HAR；也可由脚本自动跑）                                                                                          | `user_status` ∈ {401, 403}；`verify_session_issued` = false                                                                             |
| T046-5 | `turnstile-widget-passed` 真实挑战通过；`register-success`「查收确认邮件」；`inbox-confirmation`；`fake-token-rejected`；`rate-limited`           | `turnstile_real_key` = true；`register_api_status` = 200；`fake_token_status` = 400；`rate_limit_status` = 429                          |
| T046-6 | `github-consent`（azsou-test 的 OAuth 应用）；`final-signed-in`（回到 `/forum/` 已登录）；`code-replay-rejected`；`bad-state-rejected`            | `final_origin` = 预览站源；`final_path` = `/forum/`；`code_replay_rejected` = true；`bad_state_rejected` = true                         |
| T074   | `callback-replay-table`（`tests/redirect-vectors.ts` 全表执行记录）                                                                               | `vectors_total` > 0；`vectors_rejected_or_idempotent` = `vectors_total`；`offsite_navigations` = 0                                      |

## 执行

```bash
I01_CONFIRM_ISOLATED=1 I01_SUPABASE_URL=https://ovvfwkmqlejcpatmfqcd.supabase.co I01_SUPABASE_ANON_KEY=<publishable> \
I01_SITE_URL=https://<预览站> node scripts/i01/real-acceptance.mjs --manual-evidence=<证据目录>
echo $?   # 只有 0 才算 I01 真实链路验收通过
```

报告 `test-results/i01-real/report.json` 的 `summary` 列出预期数、执行数、通过 / 失败 / 阻塞 / 未执行的用例。退出码测试：`tests/unit/i01-runner.test.ts`。

**状态（2026-10-28）：未执行。** 预览站未按锁定候选 SHA 部署（需站长批准），人工证据尚未采集。
