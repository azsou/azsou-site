#!/usr/bin/env node
/**
 * A03 无 pg_cron 时的外部调度入口（待站长批准后才接入任何调度器；本仓库不会自动运行它）。
 *
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=… node scripts/ops/workflow-tick.mjs [来源名]
 *
 * 调 rpc/mod_workflow_tick_job（发布到期内容，写 workflow_tick_runs）→ rpc/az_workflow_alert（不健康时给管理员发站内通知）。
 * 每次调用写一行心跳（来源 + 期望间隔，默认 60 秒；WORKFLOW_TICK_INTERVAL 覆盖），超过 2× 间隔未更新即告警。
 * 退出码：0 = 健康；1 = 调度失败或不健康（调度器 / CI 据此告警）；2 = 缺配置。
 * 密钥只从环境变量读，不打印、不写文件。
 */
export async function runTick({
  url,
  key,
  source = 'external',
  intervalSeconds = 60,
  fetchImpl = fetch,
  restPath = '/rest/v1',
}) {
  // Supabase 的 PostgREST 挂在 /rest/v1；自建 PostgREST（本地测试）直接在根路径：restPath = ''
  const base = url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + restPath;
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const call = async (fn, body) => {
    const r = await fetchImpl(`${base}/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${fn} HTTP ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const run = await call('mod_workflow_tick_job', { p_source: source, p_interval_seconds: intervalSeconds });
  const health = await call('az_workflow_alert');
  return { run, health, ok: !!health?.ok && !run?.failed };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(2);
  }
  runTick({
    url,
    key,
    source: process.argv[2] || 'external',
    intervalSeconds: Number(process.env.WORKFLOW_TICK_INTERVAL) || 60,
  })
    .then((r) => {
      console.log(JSON.stringify({ run: r.run, health: r.health }));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`调度失败：${e.message}`);
      process.exit(1);
    });
}
