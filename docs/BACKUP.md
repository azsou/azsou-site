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

### 定时备份（GitHub Actions，P5 落地）

`.github/workflows/` 里加一个每日任务：用仓库 Secret `SUPABASE_DB_URL` 跑 ② 和 ①，产物 `gpg --symmetric`（Secret `BACKUP_PASSPHRASE`）后上传为 Actions artifact（保留 14 天）或推到私有存储桶。工作流文件在 P5 的 T5.3 提交。

## 3. 恢复 / 换库（任意标准 Postgres：Neon、RDS、自建）

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

## 4. 本地演练

```bash
bash scripts/pg-local.sh start          # 一次性本地 Postgres（端口 54329）
npm run test:db                         # 迁移 + RLS 矩阵 + 后台 RPC 测试都在临时库上跑
```
