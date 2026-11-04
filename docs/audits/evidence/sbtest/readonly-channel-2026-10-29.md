# azsou-test preflight 运行记录（已打码）

> **第八轮更正（2026-10-29）**：本记录原文把 `GET /v1/projects` 的 403 写成「列项目被拒即说明令牌只限一个项目」，这个推论不成立——403 只记录，**不能证明**令牌范围（范围只以站长提供的令牌配置记录为准）；原文的 401 解释同样不一律成立，401 按正文分为 `no_api_key` / `invalid_api_key` / `other`。下面只改了这两处措辞，状态码与请求记录未动。

- 时间：2026-10-28T16:10:59.631Z
- 执行器：scripts/sbtest/init-executor.mjs（同一执行器，preflight 子命令 = execute 的 P0 + P1 段，只读）
- 凭据模式：injected（执行器不带 Authorization / apikey 头；凭据由 vault 按主机名在线路上注入）
- 端点：Management API https://api.supabase.io（允许清单）；项目 https://ovvfwkmqlejcpatmfqcd.supabase.co
- 结论：通过：目标身份一致，C0 空库（未发任何写请求）

## 目标身份（GET /v1/projects/{ref}）

| 项              | 值                   |
| --------------- | -------------------- |
| ref             | ovvfwkmqlejcpatmfqcd |
| name            | azsou-test           |
| region          | ap-southeast-1       |
| status          | ACTIVE_HEALTHY       |
| organization_id | ojtb…jo              |
| db_version      | 17.11.0.003          |

## 令牌范围

- GET /v1/projects → 403：只记录（403 不能证明令牌范围）
- 能做：GET /v1/projects/{ref}、POST /v1/projects/{ref}/database/query/read-only（以 supabase_read_only_user 执行）
- 不能 / 未尝试：列出账号下全部项目（403）；任何写端点（database/query、Auth Admin、Storage 写）本次一律未调用

## 只读身份核对

| 项               | 值                        |
| ---------------- | ------------------------- |
| current_database | postgres                  |
| current_user     | supabase_read_only_user   |
| version          | PostgreSQL 17.11          |
| server_addr      | 2406:x:x:…（IPv6 已打码） |
| server_port      | 5432                      |
| in_recovery      | false                     |

## C0 空库核对

| 项                         | 值                                                               |
| -------------------------- | ---------------------------------------------------------------- |
| server_version             | 17.11                                                            |
| public_relations           | 0                                                                |
| public_functions           | 0                                                                |
| private_schema             | false                                                            |
| az_init_schema             | false                                                            |
| supabase_migrations_schema | false                                                            |
| cron_extension             | false                                                            |
| cron_schema                | false                                                            |
| cron_jobs                  | 0                                                                |
| pg_net_extension           | false                                                            |
| auth_users                 | 0                                                                |
| auth_identities            | 0                                                                |
| auth_sessions              | 0                                                                |
| auth_refresh_tokens        | 0                                                                |
| storage_buckets            | 0                                                                |
| storage_objects            | 0                                                                |
| extensions                 | pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp |

C0 问题：无（空库）

## 请求记录（只有方法 / 路径 / 状态 / 耗时）

| #   | 阶段 | 方法 | 路径                                                       | 状态 | 耗时 ms |
| --- | ---- | ---- | ---------------------------------------------------------- | ---- | ------- |
| 1   | P0   | GET  | /v1/projects/ovvfwkmqlejcpatmfqcd                          | 200  | 197     |
| 2   | P0   | GET  | /v1/projects                                               | 403  | 116     |
| 3   | P1   | POST | /v1/projects/ovvfwkmqlejcpatmfqcd/database/query/read-only | 201  | 1545    |
| 4   | P1   | POST | /v1/projects/ovvfwkmqlejcpatmfqcd/database/query/read-only | 201  | 1488    |
| 5   | PJ   | GET  | /auth/v1/settings                                          | 401  | 236     |
| 6   | PJ   | GET  | /storage/v1/bucket                                         | 200  | 330     |

## 备注

- 项目主机探测 GET /auth/v1/settings（需要 apikey 头） → HTTP 401（该头没有被注入）
- 项目主机探测 GET /storage/v1/bucket（需要 Authorization 头） → HTTP 200（有凭据被注入并被接受）
