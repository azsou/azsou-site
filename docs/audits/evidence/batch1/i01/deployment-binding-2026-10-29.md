# 第六轮 ⑤：I01 真实链路执行器绑定实际部署的候选（2026-10-29）

执行器 `scripts/i01/real-acceptance.mjs` 在发出任何验收请求之前做部署绑定（只读 GitHub Deployments API）：

| 绑定项      | 要求                                                                                       | 不符  |
| ----------- | ------------------------------------------------------------------------------------------ | ----- |
| 候选 SHA    | `I01_CANDIDATE_SHA`（40 位）= GitHub deployment 的 sha = 人工证据 `candidate_sha`          | 2 / 1 |
| 部署        | `I01_GITHUB_DEPLOYMENT_ID`：environment = Preview、创建者 vercel[bot]、当前状态 success    | 2     |
| 预览地址    | 状态里的 environment_url 的源 = `I01_SITE_URL`；分支别名 `*-git-*`（会漂移）拒绝           | 2     |
| Vercel 部署 | 给了 `I01_VERCEL_DEPLOYMENT_ID`（`dpl_…`）时必须出现在该部署的状态里                       | 2     |
| 向量全表    | T074 `vectors_executed` = `scripts/i01/redirect-vectors.mjs` 的 `allVectors()` 42 条各一次 | 1     |

向量表数据从 `tests/redirect-vectors.ts` 搬到 `scripts/i01/redirect-vectors.mjs`（ts 文件原样再导出，内容逐条比对一致）。

## 修复前 / 修复后

- 修复前（8f647f5 的执行器 + 新测试）：`Tests 15 failed | 21 passed (36)`——分支别名当预览站、部署 sha 不是候选、部署失败、
  environment_url 不符、不是 Preview、不是 vercel[bot]、GitHub 查不到、Vercel id 不符、证据 candidate_sha 不是实际部署、
  T074 只跑部分 / 重复凑数 / 总数不是全表，**全部被旧执行器放行**。
- 修复后：`tests/unit/i01-runner.test.ts` 36 条 + `tests/unit/safe-next.test.ts` 全过（子进程无网络，GitHub 由假数据回答）。

## 当前真实状态（只读，2026-10-29）

azsou-test 的 Preview 尚未部署任何候选（站长未批准 Preview 部署）；源 PR 头的 Vercel 自动 Preview 构建按设计失败
（这些分支没有 PUBLIC_SUPABASE_URL / KEY，fail-closed）。所以 I01 真实验收仍阻塞于：候选 Preview 部署（需批准）、人工证据。
