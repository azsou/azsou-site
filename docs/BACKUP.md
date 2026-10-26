# 数据备份、导出与换库

v2 的数据分两类：

| 类型                                                                                               | 存放                                             | 备份方式                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| 官方内容（应用 / 游戏 / 文章 / 作品 / 论坛种子 / 页面）                                            | Git（`src/content/`、`src/data/`、`src/pages/`） | Git 本身；后台「官方内容」页只读并链接到 GitHub 编辑页         |
| 用户内容与站点状态（主题、回复、评论、资料、点赞、收藏、举报、通知、审计日志、封禁记录、站点设置） | Postgres（目前是 Supabase）                      | 下面的 `pg_dump`；后台「导入导出」页另可导出 UGC 的 JSON / CSV |

## 1. 后台导出（快速、无需数据库凭据）

管理员 → `/admin/data/`：

- **导出全部（JSON）**：`forum_threads`、`forum_replies`、`comments`（含已隐藏）与 `profiles`（昵称 / 角色 / 封禁 / 注册时间）。
  **不含邮箱或任何认证信息**——邮箱只在 `auth.users`，导出接口读不到。
- **CSV**：每张表一份，UTF-8 BOM（Excel 直接打开），单元格防公式注入（`=`、`+`、`-`、`@` 开头加 `'`）。
- **站点设置**：导出 / 导入 `site_content`（`kind = 'setting'`）的 JSON；导入前校验与清洗，只接受 `announcement` / `forum` / `registration`。

这类导出适合留档或迁移内容，但**不是完整备份**（不含审计日志、举报、通知、封禁记录、点赞 / 收藏、函数与策略）。

## 2. 完整备份：pg_dump

连接串：Supabase Dashboard → Project Settings → Database → Connection string（用 _Session pooler_ 或直连；`pg_dump` 不能走 Transaction pooler）。

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<密码>@aws-0-<region>.pooler.supabase.com:5432/postgres'

# ① 结构 + 数据（public schema），自定义格式，便于选择性恢复
pg_dump "$DATABASE_URL" --schema=public --no-owner --no-privileges \
  --format=custom --file="azsou-$(date +%F).dump"

# ② 只要数据（结构由 db/migrations 重建，推荐用于换库）
pg_dump "$DATABASE_URL" --schema=public --data-only \
  --format=custom --file="azsou-data-$(date +%F).dump"

# ③ 用户账户（auth.users，含邮箱与密码哈希）——只在换库且要保留登录时需要，妥善保管
pg_dump "$DATABASE_URL" --schema=auth --table=auth.users --data-only \
  --format=custom --file="azsou-auth-users-$(date +%F).dump"
```

建议：本地 `pg_dump` 版本 ≥ 服务器版本（Supabase 目前是 Postgres 15/17）；备份文件加密存放（`gpg -c`），不要提交进仓库。

### 定时备份（GitHub Actions）

工作流 `.github/workflows/db-backup.yml`（脚本 `scripts/db-backup.sh`，本地也能直接用）：

| 项目 | 设置                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 时间 | **每周一 03:30（北京时间）**，cron `30 19 * * 0`（UTC 周日 19:30）；也可在 Actions 页面手动运行                               |
| 保留 | 产物上传为 workflow artifact `db-backup-<run id>`，**保留 30 天**，过期由 GitHub 自动删除                                     |
| 内容 | `azsou-public-*.dump`（public 全部结构 + 数据 + 策略 + 授权）、结构 SQL、行数清单、SHA256 校验和；配置口令时另含 `auth.users` |
| 加密 | 配置 Secret `BACKUP_PASSPHRASE` 后全部产物用 gpg AES256 加密；解密：`gpg -d 文件.gpg > 文件`                                  |
| 需要 | 仓库 Secret `SUPABASE_DB_URL`（Session pooler，端口 5432）；未配置时工作流成功结束并提示「跳过备份」                          |

- 定时触发只在默认分支 `main` 上生效；合并前可在 Actions → DB backup → Run workflow 选 `v2/astro` 手动运行。
- 30 天 ≈ 最近 4–5 份周备份。需要更久的留档：每月下载一份放到自己的加密存储里。
- 批量删除、导入、生产迁移之前，先手动运行一次。

## 3. 恢复 / 换库（任意标准 Postgres：Neon、RDS、自建）

**推荐用脚本**（与恢复演练同一套）：

```bash
# 整库恢复（灾难恢复：恢复到新的 Supabase 项目 / 新库）
psql "$NEW_DATABASE_URL" -f db/shim/plain.sql      # 新的 Supabase 项目不需要这一步
bash scripts/db-restore.sh "$NEW_DATABASE_URL" azsou-public-*.dump azsou-auth-users-*.dump
psql "$NEW_DATABASE_URL" -f db/verify/status.sql   # 全部为 true
```

下面是不用脚本时的手工步骤（换库：迁移建结构 + 只导数据）：

```bash
export NEW_DATABASE_URL='postgresql://…'
# 1) Supabase 环境模拟（角色 anon / authenticated / service_role、auth.users、auth.uid()）
psql "$NEW_DATABASE_URL" -f db/shim/plain.sql
# 2) 结构：0001 基线 + 全部增量迁移（按文件名顺序）
for f in db/migrations/*.sql; do psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
# 3) 用户账户（如需保留）再导数据；--disable-triggers 避免触发器重复写通知 / 审计
pg_restore --data-only --disable-triggers --no-owner -d "$NEW_DATABASE_URL" azsou-auth-users-YYYY-MM-DD.dump
pg_restore --data-only --disable-triggers --no-owner -d "$NEW_DATABASE_URL" azsou-data-YYYY-MM-DD.dump
# 4) 自增序列对齐
psql "$NEW_DATABASE_URL" -c "select setval(pg_get_serial_sequence('public.audit_log','id'), coalesce(max(id),1)) from public.audit_log"
```

（第 4 步对 `likes`、`bookmarks`、`notifications`、`rate_limit_events`、`user_bans` 同样执行。）

之后部署 PostgREST（或任何实现了「事务内 `set local role` + `request.jwt.claims`」的 API 层），前端只需改 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY`；认证换成别的提供方时实现 `src/lib/data/types.ts` 的 `AuthProvider` 即可。

## 4. 恢复演练

`scripts/restore-drill.sh` 在**每次 CI**（db 任务）中自动运行，也可以本地运行：

1. 建源库：shim + 全部迁移 + 演练数据（`db/restore/drill-seed.sql`）；
2. 用 `scripts/db-backup.sh` 备份（含 `auth.users`），校验 SHA256；
3. A. **整库恢复**：新库只跑 shim → `scripts/db-restore.sh`（`pre-restore.sql` → pg_restore → `post-restore.sql`）；
   B. **换库恢复**：新库跑 shim + 全部迁移 → 只导数据（`--data-only --disable-triggers`）；
4. 核对：每张表行数「源库 = A = B」；A 的策略、函数（含授权）、触发器、RLS 开关、表授权与源库一致；恢复后新用户注册正常；
5. 以 A 为模板跑 RLS 角色矩阵、后台 RPC、回归、P5 测试（`DB_TEST_TEMPLATE`）。

```bash
bash scripts/pg-local.sh start                                   # 一次性本地 Postgres（端口 54329）
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres npm run db:drill
DATABASE_URL=… POSTGREST_BIN=… npm run test:db                   # 迁移 + RLS 矩阵 + 后台 RPC + 存储 RLS
```

**站长每季度做一次真实演练**：从 Actions 下载最近一份备份 → 解密 → 恢复到一个临时 Supabase 项目或本地 Postgres → 跑 `db/verify/status.sql`
并对比行数清单（`azsou-rowcounts-*.tsv`）→ 删除临时项目。
