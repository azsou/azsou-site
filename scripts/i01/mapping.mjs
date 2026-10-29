// I01：稳定候选域名 → 部署 id → SHA 的映射（第七轮，站长 2026-10-29）。
//
// 站长决定保留稳定的候选域名（Vercel 分支别名，例如 azsou-site-git-candidate-…vercel.app）做验收：
// 不硬拒、不加更宽的通配、不改 Auth / Turnstile 配置。代价是别名会随新推送漂移，所以验收**前后各记录一次**映射：
//   域名 →（Vercel 别名 / 部署 URL）→ Vercel 部署 id → 部署的 githubCommitSha → 候选分支当前头 → GitHub deployment id
// 两次记录不同 = 验收期间映射变了 → 这次的证据全部作废（退出码 3，不是通过）。验收期间候选分支冻结（不推送）；
// 分支头 ≠ 候选 SHA 也拒绝开始。全部只读（管理通道：api.vercel.com / api.github.com）。
export const CANDIDATE_BRANCH = 'candidate/2026-10-27-integrated';
export const MAPPING_KEYS = Object.freeze([
  'domain',
  'vercel_deployment_id',
  'deployment_url',
  'sha',
  'ready_state',
  'branch_head',
]);

/**
 * @param {{ siteOrigin: string, teamId?: string, branch?: string, repo?: string }} cfg
 * @param {(url: string, init?: any) => Promise<Response>} admin 管理通道
 */
export async function resolveMapping(cfg, admin) {
  const host = new URL(cfg.siteOrigin).host;
  const q = cfg.teamId ? `?teamId=${encodeURIComponent(cfg.teamId)}` : '';
  const get = async (url) => {
    const r = await admin(url);
    if (r.status >= 300 && r.status < 400)
      throw new Error(`${new URL(url).pathname} → HTTP ${r.status}（重定向不跟随）`);
    return r;
  };
  let kind = 'alias';
  let dpl;
  const a = await get(`https://api.vercel.com/v4/aliases/${host}${q}`);
  if (a.status === 200) dpl = (await a.json())?.deploymentId;
  else if (a.status === 404) kind = 'deployment-url';
  else throw new Error(`Vercel 别名查询 ${host} → HTTP ${a.status}`);
  const d = await get(`https://api.vercel.com/v13/deployments/${dpl ?? host}${q}`);
  if (d.status !== 200) throw new Error(`Vercel 部署查询 ${dpl ?? host} → HTTP ${d.status}`);
  const dep = await d.json();
  const branch = cfg.branch ?? CANDIDATE_BRANCH;
  const b = await get(
    `https://api.github.com/repos/${cfg.repo ?? 'azsou/azsou-site'}/git/ref/heads/${branch}`,
  );
  if (b.status !== 200) throw new Error(`候选分支 ${branch} → HTTP ${b.status}`);
  const ref = await b.json();
  return {
    domain: host,
    kind,
    vercel_deployment_id: dep.id ?? dep.uid ?? null,
    deployment_url: dep.url ?? null,
    sha: dep.meta?.githubCommitSha ?? null,
    ready_state: dep.readyState ?? dep.status ?? null,
    branch,
    branch_head: ref?.object?.sha ?? null,
    at: new Date().toISOString(),
  };
}

/** 开始验收前的映射条件 */
export function mappingProblems(m, { candidateSha, vercelDeploymentId }) {
  const p = [];
  if (!m.vercel_deployment_id) p.push(`域名 ${m.domain} 解析不到 Vercel 部署`);
  if (m.sha !== candidateSha) p.push(`域名 ${m.domain} 指向的部署 sha ${m.sha} ≠ 候选 ${candidateSha}`);
  if (m.ready_state !== 'READY') p.push(`部署状态 ${m.ready_state}（必须 READY）`);
  if (m.branch_head !== candidateSha)
    p.push(`候选分支 ${m.branch} 当前头 ${m.branch_head} ≠ 候选 ${candidateSha}（验收期间必须冻结推送）`);
  if (vercelDeploymentId && m.vercel_deployment_id !== vercelDeploymentId)
    p.push(`域名解析到 ${m.vercel_deployment_id}，不是 I01_VERCEL_DEPLOYMENT_ID ${vercelDeploymentId}`);
  return p;
}

/** 前后两次映射的差异（任何一项不同 → 证据作废） */
export function mappingChanged(before, after) {
  return MAPPING_KEYS.filter((k) => (before?.[k] ?? null) !== (after?.[k] ?? null)).map(
    (k) => `${k}: ${before?.[k] ?? '（无）'} → ${after?.[k] ?? '（无）'}`,
  );
}
