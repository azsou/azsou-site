# 受保护的手动备份：站长操作卡（运维 PR #8 与 PR #5 同一份）

站长第三轮（2026-10-28）：`.github/workflows/db-backup.yml` **仅手动触发**，不合并就不会运行；合并（站长批准）后也只能手动运行，并且每次都要审批。
完整说明（恢复范围、精确恢复 / 显式升级、RPO / RTO 差距）在 v2 分支的 `docs/BACKUP.md`。

## 1. 创建环境 `backup-production`（Settings → Environments → New environment）

| 设置                  | 值                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required reviewers    | 站长本人——这是生产库备份的真正闸门                                                                                                                         |
| Deployment branches   | Selected branches：只允许 `main`                                                                                                                           |
| Environment variables | `BACKUP_ENVIRONMENT_GUARD` = `backup-production`（环境没建好时 GitHub 会自动建一个无保护的同名环境，此变量不存在，闸门拒绝）                               |
| Environment secrets   | `SUPABASE_DB_URL`（Session pooler，5432）、`SUPABASE_URL`（`https://<ref>.supabase.co`）、`SUPABASE_SERVICE_ROLE_KEY`、`BACKUP_PASSPHRASE`（离线另存一份） |

另外：Settings → Actions → General → Artifact and log retention ≥ 30 天。

## 2. 运行

Actions → DB backup → Run workflow → 分支 `main` → 输入项目 ref → 审批人批准 → 开始。闸门（`scripts/ops/backup-guard.sh`）依次检查：
手动触发、处在受保护环境、四个 Secret 齐全、输入的 ref = 连接串的 ref = API 地址的 ref；任何一项不满足都在连接数据库之前失败。

## 3. 产物

`db-backup-<run id>`，只有 `.gpg`，保留 30 天：统一快照的 public / private / auth / storage 表与策略、Storage 文件本体（逐对象 sha256）、
逐表校验和、行数、globals、manifest（快照 id / LSN / 时间、schema 版本）。

## 4. 不在本 PR 里（默认不启用，另行启用）

每日定时、外部存储复制、独立监控——在 v2 分支的 `ops/disabled-workflows/`，各自需要站长单独批准、单独 PR。

## 5. 本 PR 自己的测试（工作流 `Ops tests`）

actionlint、shellcheck、`tests/ops/test_workflows.py`（无定时 / 环境闸门 / 并发 / 最小权限 / 确认输入 / 只上传 `.gpg`）、
`tests/ops/backup-guard.test.sh`（闸门 16 例）、`tests/ops/backup-ops-e2e.sh`（本机 Postgres 上的备份端到端 13 例）。不连接任何生产资源。
