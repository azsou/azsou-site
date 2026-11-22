# azsou-test preflight 运行记录（已打码）

> **第八轮更正（2026-10-29）**：本记录原文把 `GET /v1/projects` 的 403 写成「列项目被拒即说明令牌只限一个项目」，这个推论不成立——403 只记录，**不能证明**令牌范围（范围只以站长提供的令牌配置记录为准）；原文的 401 解释同样不一律成立，401 按正文分为 `no_api_key` / `invalid_api_key` / `other`。下面只改了这两处措辞，状态码与请求记录未动。

- 时间：2026-10-28T16:10:13.380Z
- 执行器：scripts/sbtest/init-executor.mjs（同一执行器，preflight 子命令 = execute 的 P0 + P1 段，只读）
- 凭据模式：injected（执行器不带 Authorization / apikey 头；凭据由 vault 按主机名在线路上注入）
- 端点：Management API https://api.supabase.io（允许清单）；项目 https://ovvfwkmqlejcpatmfqcd.supabase.co
- 结论：拒绝：GET /v1/projects/{ref}：HTTP 401（当时的措辞把 401 一律写成「没有注入」；第八轮起 Management API 的 401 记为 other——无法区分缺失 / 无效）

## 请求记录（只有方法 / 路径 / 状态 / 耗时）

| #   | 阶段 | 方法 | 路径                              | 状态 | 耗时 ms |
| --- | ---- | ---- | --------------------------------- | ---- | ------- |
| 1   | P0   | GET  | /v1/projects/ovvfwkmqlejcpatmfqcd | 401  | 272     |
