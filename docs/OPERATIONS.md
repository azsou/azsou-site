# 运维手册

日常管理都在站内后台 `https://azsou.com/admin/`；权限由数据库强制（RLS + `SECURITY DEFINER` 函数），后台页面只是界面。
需要直接改库时用 Supabase → SQL Editor（以 `postgres` 身份执行，不受 RLS / 限流 / 守卫触发器约束，**谨慎操作**）。

## 1. 角色与权限

| 角色   | 能做什么                                                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 访客   | 浏览全部公开内容、搜索                                                                                                                                                  |
| 用户   | 发主题 / 回复 / 评论（限流）、编辑与删除自己的内容、点赞、收藏、举报、上传图片（10 分钟 10 张、每天 50 张，单张 ≤ 2 MB）                                                |
| 被封禁 | 只能浏览、删除自己的内容；不能发帖、回复、评论、上传图片、进后台                                                                                                        |
| 版主   | 用户的全部权限（不限流）+ 置顶 / 精华 / 锁定 / 隐藏 / 删除任何帖子与评论、处理举报、警告、封禁 / 解封**普通用户**、删除任何图片；后台：概览、举报、内容、用户、官方内容 |
| 管理员 | 版主的全部权限 + 改用户角色、封禁版主、「公告」分类发帖、站点设置、审计日志、导入导出                                                                                   |

- 任何人都不能封禁、降级自己；版主不能改角色、不能封禁版主 / 管理员。
- **设第一个管理员**（SQL Editor）：

  ```sql
  update public.profiles set role = 'admin'
  where id = (select id from auth.users where email = '<邮箱>');
  ```

  之后在后台 → 用户 → 详情里改角色（仅管理员，经 `admin_set_user()`，写审计日志）。

- 被提升或撤销角色的用户刷新任一社区 / 后台页面后，顶栏「管理后台」入口会自动更新（无需重新登录）。

## 2. 内容审核

- **举报队列**（后台 → 举报队列）：按状态筛选；可单条或批量「隐藏目标 / 锁定主题 / 警告作者 / 封禁 N 天 / 驳回」，附处理说明。
  一个操作在一个事务里完成，同时通知举报人与作者并写审计日志。
- **内容管理**：主题 / 回复 / 评论表格，可按分类、隐藏、被举报、作者、关键词筛选；隐藏（软删除，可恢复）优先于删除。
- **图片**：帖子里的图片在 Storage 桶 `ugc-images`，路径 `<用户 id>/<文件名>`。隐藏帖子不会删除图片文件。
  需要删除违规图片时：Supabase → Storage → `ugc-images` → 进入该用户目录 → Delete（或版主用 Storage API 删除，RLS 允许）。
  图片地址在帖子正文的 `![说明](https://…/storage/v1/object/public/ugc-images/<用户 id>/<文件名>)` 里。
- **停用论坛分类**（后台 → 站点设置 → 论坛分类）：停用后发帖页隐藏该分类，数据库（0011）同时拒绝普通用户在该分类发新主题或把主题移入；
  版主 / 管理员不受限；已有主题照常显示、可回复。
- **关闭注册**（站点设置 → 注册）：注册页收起表单，`/api/auth/signup` 返回 403；启用了注册钩子时，绕过本站直连 GoTrue 的注册（含第三方首次登录）也被拒。
- **公告条**（站点设置 → 公告）：全站顶部提示，可带链接，5 分钟内对所有访客生效（浏览器缓存）。

## 3. 封禁与警告

- 后台 → 用户 → 详情 → 封禁：填写原因与到期时间（留空 = 永久）。到期后立即失效（权限函数实时判断），
  后台概览打开时会清理到期封禁的标志并记审计；也可以在 SQL Editor 执行 `select public.mod_lift_expired_bans();`
  （需要以版主身份；SQL Editor 中直接 `update public.profiles set banned = false where id = '…'` 也可以）。
- 警告：给用户发一条站内通知（「版主提醒」），不影响权限。
- 每次封禁 / 解封 / 警告都在 `user_bans` 与审计日志里有记录。

## 4. 备份

- **备份（仅手动触发）**：GitHub Actions 工作流 `DB backup`（`.github/workflows/db-backup.yml`），站长第三轮（2026-10-28）起
  **没有任何定时触发**，只能在 Actions 页面手动运行，并且：输入框里亲手输入项目 ref（必须与 Secret 指向的项目一致）、
  job 运行在受保护环境 `backup-production`（必需审批人 = 站长）。产物保留 30 天（Actions → DB backup → 某次运行 → Artifacts）。
  合并到 `main` 并创建环境之前一次都不会跑。站长目标 RPO ≤ 1 小时 / RTO ≤ 4 小时目前没有达到，差距与待批方案见
  [BACKUP.md §2A](BACKUP.md#2a-rpo--rto站长目标现状与差距2026-10-27)。
  - **站长需要创建环境**（Settings → Environments → New environment `backup-production`），配置见 [BACKUP.md §2E](BACKUP.md)：
    必需审批人、只允许 `main`、环境变量 `BACKUP_ENVIRONMENT_GUARD=backup-production`、
    环境 Secret `SUPABASE_DB_URL`（Session pooler 5432）、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`BACKUP_PASSPHRASE`（另外离线保存）。
  - 缺任何一项工作流**失败**、不导出任何数据；备份后自动跑 `scripts/db-verify-backup.sh`（校验和 / 解密 / `pg_restore --list` /
    行数清单 / manifest / Storage 归档 sha256），任何一步不通过都标红。
  - 每日定时、外部存储上传、独立监控：`ops/disabled-workflows/`，**默认不启用，另行启用**（各需站长单独批准）。
  - 恢复演练：`BACKUP_PASSPHRASE=… bash scripts/db-verify-backup.sh <下载的备份目录> --restore <本机隔离空库>`。
  - 每次手动大改数据前（批量删除、导入、迁移）先手动运行一次。
- **恢复**：见 [BACKUP.md §3](BACKUP.md)。分两步、互不隐含：**精确恢复**（`scripts/db-restore.sh`，只进空目标，恢复成备份时的 schema 版本，不执行迁移）→ 需要时再**显式升级**（`scripts/db-upgrade.sh --apply-migrations`）。`scripts/restore-drill.sh` 在每次 CI 中演练。
- **Storage 文件**（站长第三轮起在恢复范围内）：备份经 Storage API 下载每个对象进加密归档（逐对象 sha256），精确恢复时经 API 上传并核对。
- **不在备份里的东西**：Auth 设置、邮件模板、Vercel 环境变量、Supabase 项目设置——以 CONFIG.md 为准。
- Supabase 免费档没有平台备份；Pro 及以上有平台每日备份（Pro 可取最近 7 天），PITR 是 Pro 之上**另付费的附加项**
  （约 $100/月起，需 Small 以上计算规格），都可与本手动工作流并存（来源：supabase.com/docs/guides/platform/backups）。

## 4A. 定时发布调度（A03，迁移 0018，**待站长批准启用**）

- 现状：定时发布只在有人打开后台内容页时补偿执行（`mod_workflow_tick()`），不是无人值守。
- 推荐方案：Supabase pg_cron，SQL 见 `db/ops/workflow-cron.sql`——每分钟 `mod_workflow_tick_job('pg_cron', 60)`，
  每 5 分钟 `az_workflow_alert()`（积压超过 2 分钟、最近一次运行失败、或调度心跳超过 2× 期望间隔 → 给所有管理员发站内通知，1 小时内不重复）。
  启用需走放行申请 ② `docs/release/2026-10-27-scheduler-cron-release-request.md`（与生产迁移申请 ① 分开审批）。
- 心跳：每次无人值守 tick 写 `public.workflow_scheduler_heartbeat`（来源、时间、期望间隔）；`az_workflow_health()` 返回
  `scheduler_configured` / `heartbeat_age_seconds` / `heartbeat_stale`。调度器整体停摆时没人调告警，所以版主打开后台时的补偿 tick
  发现心跳过期也会触发告警。从未有过心跳（尚未启用调度）不算过期。
- 锁顺序：所有改公开状态的路径都「先锁内容行、后锁排程行」；tick 对内容行 `SKIP LOCKED`、锁内复核排程仍有效才发布，
  返回值里 `skipped` = 本轮因内容正被隐藏 / 编辑而跳过的条数（下一分钟再处理）。
- 站长决定（2026-10-27）：隐藏已排期内容默认取消排期；恢复不自动复活旧排期。站长第二轮（2026-10-27 21:06）：恢复默认回到「待审」，公开要点显式「发布」（0019 `mod_publish_content`，审计 `content.published`）。
- 内容版本保留 90 天：`select public.az_prune_content_versions(90);`（表所有者 / service_role；未排定时任务，见放行申请 ② §7）。
  承诺：到期 2 分钟内公开；双 worker 不重复发布（`FOR UPDATE SKIP LOCKED`，`tests/db/batch2.test.ts` T062）。
- 无 pg_cron 的替代：任意外部调度器以 service_role 调 `node scripts/ops/workflow-tick.mjs <来源名>`
  （环境变量 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`；退出码 1 = 不健康，调度器据此告警）。
  可选调度器与限制：Vercel Cron（Pro 才能每分钟；Hobby 每天一次，达不到 2 分钟承诺）、cron-job.org 一类外部服务
  （需要部署一个持有 service_role 密钥的函数，密钥不能出现在浏览器）、GitHub Actions schedule（最短 5 分钟且常延迟，
  只适合作为兜底告警，不满足 2 分钟承诺）。
- 观察：`select * from public.workflow_tick_runs order by id desc limit 20;`、`select public.az_workflow_health();`
  （后台版主也能读这两项）。孤儿排程（目标已删）记在 `content_workflow.orphaned_at` 与审计 `content.workflow.orphaned`。
- 停用：`select cron.unschedule('az-workflow-tick'); select cron.unschedule('az-workflow-health');`

## 5. 更换密钥

| 密钥                                | 在哪里换                                                                                | 换完要做                                                                                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库密码                          | Supabase → Project Settings → Database → Reset database password                        | 更新仓库 Secret `SUPABASE_DB_URL`；其他地方都不用数据库密码                                                                                                                                                                      |
| Supabase publishable key            | Project Settings → API Keys → 新建 publishable key                                      | Vercel 设 `PUBLIC_SUPABASE_KEY` → Redeploy；确认无误后在 Supabase 删除旧 key。keepalive 工作流可设 Secret `SUPABASE_PUBLISHABLE_KEY`                                                                                             |
| Supabase secret / service_role key  | Project Settings → API Keys                                                             | 本站代码**不使用** secret key，泄露时直接作废重建即可                                                                                                                                                                            |
| JWT 签名密钥                        | Project Settings → JWT Keys → Rotate                                                    | 所有用户需要重新登录（旧会话失效）；无需改代码                                                                                                                                                                                   |
| Turnstile 私钥                      | Cloudflare → Turnstile → 站点 → Rotate secret key                                       | Vercel 更新 `TURNSTILE_SECRET_KEY` → Redeploy（Cloudflare 旋转期间新旧密钥都有效）                                                                                                                                               |
| 注册票据密钥 `SIGNUP_TICKET_SECRET` | 自己生成：`openssl rand -hex 32`                                                        | **两处同时改**：Vercel 环境变量（Redeploy）+ SQL `update private.app_settings set value = '<新>' , updated_at = now() where key = 'signup_ticket_secret';`。两处不一致期间邮箱注册会被拒（第三方登录不受影响），建议在低峰时操作 |
| GitHub / Google OAuth 密钥          | GitHub → Settings → Developer settings → OAuth Apps；Google Cloud Console → Credentials | Supabase → Authentication → Providers 里更新 Client Secret                                                                                                                                                                       |
| SMTP 密码                           | 邮件服务商后台                                                                          | Supabase → Authentication → Emails → SMTP Settings 更新                                                                                                                                                                          |
| 备份口令 `BACKUP_PASSPHRASE`        | GitHub Secret                                                                           | 旧备份仍需旧口令解密，旧口令保留到旧备份过期（30 天）                                                                                                                                                                            |

## 6. 监控

- **GitHub Actions 失败邮件**：CI、DB backup、Supabase keepalive 失败时 GitHub 会给仓库管理员发邮件（个人设置 → Notifications → Actions）。
- **Supabase**：Dashboard → Reports（API 请求、数据库负载）、Logs Explorer（API / Auth / Postgres / Storage 日志）、
  Advisors（安全与性能建议，每次迁移后看一眼）。免费项目一周无请求会暂停，keepalive 工作流每 3 天访问一次。
- **Vercel**：Deployments（构建失败通知）、Logs（Function 日志：`/api/auth/*` 的 Turnstile 失败、上游错误）、
  可选开启 Speed Insights（需在 CSP 的 `script-src` / `connect-src` 加 Vercel 的域名，并重新运行 `npm run test:csp`）。
- **可用性**：建议用免费的外部监控（UptimeRobot / Better Stack）每 5 分钟检查 `https://azsou.com/` 与
  `https://azsou.com/forum/sitemap-threads.xml`（后者会访问数据库，可以同时发现 Supabase 暂停或故障）。
- **限流**：`rate_limit_events` 每个用户只保留 24 小时内的计数（触发时自动清理）；若表变大，可在 SQL Editor 执行
  `delete from public.rate_limit_events where created_at < now() - interval '1 day';`，或用 pg_cron 每天执行。
- **审计日志**：后台 → 审计日志，可按动作 / 操作人筛选并导出 CSV。

## 7. 内容更新（官方内容）

官方内容（应用 / 游戏 / 文章 / 作品 / 页面）在 Git 里：编辑 `src/content/**` → 提交到分支 → 开 PR（Vercel 自动生成预览）→ 合并即上线。
后台「官方内容」页列出全部条目并链接到 GitHub 编辑页。

## 8. 常见问题

| 现象                                   | 排查                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 论坛显示「只读模式」                   | Supabase 暂停或故障：Dashboard 查看项目状态，必要时 Restore；keepalive 工作流是否在跑                                    |
| 注册提示「人机验证失败」               | Vercel 的 `TURNSTILE_SECRET_KEY` 与站点密钥不配套，或当前域名不在 Turnstile 主机名列表里                                 |
| 注册提示「请在 azsou.com 的注册页面…」 | 注册钩子已启用但 Vercel 与数据库的 `SIGNUP_TICKET_SECRET` 不一致，或 Vercel 没有 Redeploy                                |
| 收不到确认邮件                         | 未配置自定义 SMTP 时 Supabase 每小时只发 2 封；按 CONFIG.md 配置 SMTP                                                    |
| 图片上传失败「账户受限，或上传太频繁」 | 用户被封禁，或触发限流（10 分钟 10 张 / 24 小时 50 张）；`ugc-images` 桶不存在时提示「图片存储还没有开通」→ 执行 0010    |
| 页面报 CSP 错误（控制台 Refused to …） | 新增了外部资源或内联脚本：改 `vercel.json` 的 CSP（内联脚本用 `npm run csp:update`），CI 的 `test:csp` 与 E2E 会帮你发现 |

## 留言板与友链审核（P7，迁移 0015）

- **留言**：后台「留言审核」（`/admin/guestbook/`，版主与管理员）。新留言都在「待审核」；通过后出现在 `/guestbook/`，拒绝的只在后台可见，也可以「退回待审核」或删除。每个操作写审计日志（`guestbook.*`）。
- **友链**：后台「友链审核」（`/admin/links/`，仅管理员），能看到申请人留的联系方式；通过后出现在 `/links/`（审计 `friend_link.*`）。同一网址在待审核 / 已通过时不能重复申请。
- **防刷**：提交必须经过本站 Turnstile + 服务端票据（`COMMUNITY_TICKET_SECRET`，与 `private.app_settings.community_ticket_secret` 相同）；同一访客留言 3 次 / 10 分钟、10 次 / 天，友链 2 次 / 天；待审核超过 200 / 50 条时暂停接收。换密钥：两处同时改（先数据库后 Vercel，期间提交会失败几分钟）。
