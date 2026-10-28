# azsou-test preflight 运行记录（已打码）

- 时间：2026-10-28T16:10:13.380Z
- 执行器：scripts/sbtest/init-executor.mjs（同一执行器，preflight 子命令 = execute 的 P0 + P1 段，只读）
- 凭据模式：injected（执行器不带 Authorization / apikey 头；凭据由 vault 按主机名在线路上注入）
- 端点：Management API https://api.supabase.io（允许清单）；项目 https://ovvfwkmqlejcpatmfqcd.supabase.co
- 结论：拒绝：GET /v1/projects/{ref}：HTTP 401——线路上没有注入凭据（主机 api.supabase.io 缺 vault 绑定，或进程没走注入代理：Node 需 NODE_USE_ENV_PROXY=1）

## 请求记录（只有方法 / 路径 / 状态 / 耗时）

| #   | 阶段 | 方法 | 路径                              | 状态 | 耗时 ms |
| --- | ---- | ---- | --------------------------------- | ---- | ------- |
| 1   | P0   | GET  | /v1/projects/ovvfwkmqlejcpatmfqcd | 401  | 272     |
