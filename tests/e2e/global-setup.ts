/**
 * 社区（P3）E2E 的真实后端：本地 Postgres 跑 shim + 全部迁移，起 PostgREST 14，浏览器里对
 * Supabase /rest/v1 的请求由 Playwright 转发过去 —— 发帖 / 回帖 / RLS / 触发器 / 限流全部是真的。
 * 需要 DATABASE_URL（超级用户）与 POSTGREST_BIN；缺少时社区用例跳过（CI 设 E2E_REQUIRE_DB=1 则直接失败）。
 */
import pg from 'pg';
import { SHIM, createDatabase, dbUrl, dropDatabase, migrationFiles } from '../db/helpers';
import { BIN, ensureAuthenticator, startPostgrest } from '../db/postgrest';
import { COMMUNITY_TEST_SECRET } from '../../src/lib/server/community-submit';

export const E2E_DB = `azsou_e2e_${process.pid}`;
export const E2E_DB_V72 = `azsou_e2e_v72_${process.pid}`;
export const E2E_DB_PRE17 = `azsou_e2e_pre17_${process.pid}`;
export const SEED_BOT = '00000000-0000-4000-a000-0000000000b0';

export default async function globalSetup() {
  if (!process.env.DATABASE_URL || !BIN) {
    if (process.env.E2E_REQUIRE_DB) throw new Error('E2E_REQUIRE_DB=1 但缺少 DATABASE_URL / POSTGREST_BIN');
    console.warn('[e2e] 未配置 DATABASE_URL / POSTGREST_BIN：社区（P3）用例将跳过');
    return;
  }
  await createDatabase(E2E_DB, [SHIM, ...migrationFiles()]);
  await ensureAuthenticator();
  const c = new pg.Client({ connectionString: dbUrl(E2E_DB) });
  await c.connect();
  try {
    // 留言 / 友链提交（0015）的票据密钥：与 /api/submit 本地用的测试密钥相同（p7.spec.ts 在测试进程里跑真实 Function 逻辑）
    await c.query(
      `insert into private.app_settings (key, value) values ('community_ticket_secret', $1)
       on conflict (key) do update set value = excluded.value`,
      [COMMUNITY_TEST_SECRET],
    );
    // 列表分页夹具：一位用户在「站务反馈」里的 30 个主题，时间依次递减
    await c.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'bot@example.com', '{"name":"分页机器人"}')`,
      [SEED_BOT],
    );
    await c.query(
      `insert into public.forum_threads (cat, title, body, author, created_at)
       select '站务反馈', '分页夹具主题 ' || lpad(g::text, 2, '0'), '用于测试「加载更多」。', $1, now() - (g || ' minutes')::interval
       from generate_series(1, 30) g`,
      [SEED_BOT],
    );
  } finally {
    await c.end();
  }
  const port = 54400 + (process.pid % 500);
  const child = await startPostgrest(E2E_DB, port);
  process.env.E2E_PGRST = `http://127.0.0.1:${port}`;
  process.env.E2E_DB_URL = dbUrl(E2E_DB);
  // A15：旧结构的库（真实 PostgREST，不是 mock）——
  //   v72 = shim + 0001（与生产库现状一致：0002–0017 都没执行）；pre17 = shim + 0001…0016（缺 0017）
  const all = migrationFiles();
  const legacy = [
    { db: E2E_DB_V72, files: all.filter((f) => /\/0001_/.test(f)), env: 'V72' },
    { db: E2E_DB_PRE17, files: all.filter((f) => !/\/0017_/.test(f)), env: 'PRE17' },
  ];
  const children = [child];
  for (const [i, l] of legacy.entries()) {
    await createDatabase(l.db, [SHIM, ...l.files]);
    const p = port + 1 + i;
    children.push(await startPostgrest(l.db, p));
    process.env[`E2E_PGRST_${l.env}`] = `http://127.0.0.1:${p}`;
    process.env[`E2E_DB_URL_${l.env}`] = dbUrl(l.db);
  }
  return async () => {
    for (const c of children) c.kill();
    await dropDatabase(E2E_DB).catch(() => {});
    for (const l of legacy) await dropDatabase(l.db).catch(() => {});
  };
}
