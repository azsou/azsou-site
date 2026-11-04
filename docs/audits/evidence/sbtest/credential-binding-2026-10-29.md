# 凭据绑定声明（打码）与 Management API 主机核对——第七轮 ①②（2026-10-29 08:11 CST，只读）

> 范围：只读 GET 与 `/database/query/read-only`，只对 azsou-test（`ovvfwkmqlejcpatmfqcd`）与 `api.supabase.io`。**未联系 `api.supabase.com`、未联系生产 ref、未改任何绑定、未写入任何东西。**
> 本文件不含任何密钥、令牌或密钥尾号。

## 1. 能枚举的：vault 条目（`list_secrets`，只有 id 前缀 / 标签 / vault 范围）

| vault 条目  | 标签（原文）                        | vault 范围（scope）                    | 备注                                                       |
| ----------- | ----------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `2876342d…` | azsou-test service_role key         | `api.ovvfwkmqlejcpatmfqcd.supabase.co` | 这个主机不存在：无凭据 GET → 502 `upstream request failed` |
| `d1d12458…` | azsou-test 只读 PAT（Supabase）     | `api.supabase.com`                     | 与下一条**同一范围**                                       |
| `33d5c69b…` | Supabase 个人访问令牌（sbp\_ 开头） | `api.supabase.com`                     | 生产范围的 PAT                                             |
| `033dd35c…` | azsou-test anon / publishable key   | （无范围）                             |                                                            |
| `2b9e1e3b…` | azsou-test 数据库连接串             | `ovvfwkmqlejcpatmfqcd.supabase.co`     | 连接串不是 HTTP 凭据，却与项目 API 主机同一范围            |
| `621a511d…` | Supabase 数据库连接串（azsou）      | `abryflgoljltyakthtql.supabase.co`     | 生产，本轮未触碰                                           |
| `cc63716e…` | Vercel token（仅 azsou-site）       | `api.vercel.com`                       | 本轮未使用                                                 |

## 2. 不能枚举的：connect_service 服务绑定 → 一律 **unknown**

沙箱里没有列出服务绑定的工具（`connect_service` 只能新建；`list_secrets` 只列 vault 条目）。所以下面每个主机「注入的是哪条密钥、用哪个头」**只写观测到的行为，来源写 unknown**。
早先运行记录里提到的服务名（例如 `sbtest-mgmt-ro`、`sbtest-service`）**本轮无法确认，不作为事实引用**。

| 主机（通道）                                                | 观测（curl / Node，请求本身不带任何凭据）                                                                                                                          | 注入的头                                            | 是否覆盖请求里已有的同名头                                     | 来源密钥                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `api.supabase.io`（Management API：目标身份 / 只读查询）    | `GET /v1/projects/{ref}` 200；`GET /v1/projects` 403；`GET /` 404                                                                                                  | `Authorization`（推断：Management API 只认 Bearer） | **是**：手动带 `Authorization: Bearer sbp_invalid` 仍然 200    | unknown                                                                  |
| `ovvfwkmqlejcpatmfqcd.supabase.co`（项目 API：Storage）     | `GET /storage/v1/bucket` 200 `[]`                                                                                                                                  | `Authorization`                                     | **是**：手动带 `Authorization: Bearer not-a-jwt` 仍然 200 `[]` | unknown                                                                  |
| `ovvfwkmqlejcpatmfqcd.supabase.co`（项目 API：Auth / REST） | `GET /auth/v1/admin/users?per_page=1` 401 `No API key found`；`GET /auth/v1/settings` 401；`GET /rest/v1/` 401；手动带 `apikey: not-a-key` → 401 `Invalid API key` | **没有 `apikey`**                                   | `apikey` 不被注入（请求里自带的无效值原样到达）                | —                                                                        |
| `api.ovvfwkmqlejcpatmfqcd.supabase.co`                      | `GET /` 502 `upstream request failed`                                                                                                                              | unknown                                             | unknown                                                        | unknown                                                                  |
| `api.supabase.com`（公共 Management API 域名）              | **本轮未联系**                                                                                                                                                     | unknown                                             | unknown                                                        | unknown（vault 里有两条同范围条目：只读 PAT 与生产 PAT，注入哪条不可知） |

结论：

- **项目服务准入当前不接受**：执行器 `preflight` 实跑 `GET /auth/v1/admin/users?per_page=1` → 401（`readonly-admission-2026-10-29.md`）。Storage 200 不能说明注入的是 service_role。
- 项目主机上**有一个来源不明的 `Authorization` 注入**，它会覆盖请求里自带的 `Authorization`。这意味着从沙箱经注入代理发往这个主机的**任何用户 / anon 请求都会被它改写**——I01 的用户验收通道必须走不经注入代理的独立客户端（见 #4 `scripts/i01/channels.mjs`）。
- `api.supabase.com` 上两条同范围的 vault 条目（azsou-test 只读 PAT、生产 PAT）注入哪条不可知，这是执行器永不使用该主机的原因之一。它是**公共 Management API 域名**，不是「生产 API」。

## 3. `api.supabase.io` 的最终主机与重定向（无凭据 curl，`--max-redirs 0` 与 `-L` 各一次）

| 请求                                               | 状态 | 重定向次数 | Location | 最终 URL                                                   |
| -------------------------------------------------- | ---- | ---------- | -------- | ---------------------------------------------------------- |
| `HEAD https://api.supabase.io/`                    | 404  | 0          | —        | `https://api.supabase.io/`                                 |
| `GET https://api.supabase.io/`                     | 404  | 0          | —        | `https://api.supabase.io/`                                 |
| `GET https://api.supabase.io/v1/projects/{ref}`    | 200  | 0          | —        | `https://api.supabase.io/v1/projects/ovvfwkmqlejcpatmfqcd` |
| `GET https://api.supabase.io/v1/projects`          | 403  | 0          | —        | `https://api.supabase.io/v1/projects`                      |
| `GET -L https://api.supabase.io/v1/projects/{ref}` | 200  | 0          | —        | 同上                                                       |

响应头 `Server: cloudflare`、`X-Powered-By: Express`。连接经沙箱出口代理（remote_ip 为代理地址），所以看不到真实 DNS / CNAME；**能确认的只有：没有任何 HTTP 重定向，最终主机就是 `api.supabase.io`**。
执行器仍然 `redirect: 'manual'`、任何 3xx 拒绝（单测：跨主机 302 → `api.supabase.com` 拒绝且不发请求；同主机 307 也拒绝）。

## 4. 绑定调整方案（**只是方案，未执行；不改任何现有绑定**）

1. **确认并移除项目主机上来源不明的 `Authorization` 注入**：站长在 Hark 已连接服务 / vault 里找出绑到 `ovvfwkmqlejcpatmfqcd.supabase.co` 的服务，告诉我们它是哪条密钥；在它被确认之前，执行器的准入只认 Auth Admin 200 + `{users:[…]}`，不会因为 Storage 200 而开始写。
2. **service_role（或新版 `sb_secret_…`）绑定到 `ovvfwkmqlejcpatmfqcd.supabase.co`，注入 `apikey` 头**（原始值，无前缀）。旧版 JWT 型 service_role 还需要 `Authorization: Bearer` 同值；新版 secret key 只要 `apikey`。
   绑定后先跑 `preflight`：准入必须是「接受」（200 + `{users:[…]}`）才可能申请 `execute`。
3. **未来初始化 PAT**（新 vault 条目，经 vault 表单）：绑定到 `api.supabase.io`，`Authorization: Bearer`；令牌配置 = 只授权 azsou-test，**Project Settings Read + Database Read-write**，没有其他权限、没有账号级 Projects、不是 Legacy。范围证明 = 站长提供的令牌配置记录。
4. vault 条目 `2876342d…` 的范围写的是不存在的主机，`2b9e1e3b…`（连接串）的范围与项目 API 主机相同——建议站长把两者的范围改成与实际用途一致；改不改、怎么改由站长决定。
