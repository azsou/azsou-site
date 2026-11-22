/** 本地 PostgREST（与生产同一大版本 14.x）：起进程、签 JWT。POSTGREST_BIN 未设置时相关测试跳过。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { ADMIN_URL, dbUrl } from './helpers';

export const BIN = process.env.POSTGREST_BIN;
const SECRET = 'test-secret-test-secret-test-secret-0123456789';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function jwt(claims: Record<string, unknown>) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export const ANON = jwt({ role: 'anon' });
export const tok = (uid: string) => jwt({ role: 'authenticated', sub: uid });

export async function ensureAuthenticator() {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then
      create role authenticator login noinherit password 'authenticator';
    end if; end $$;`);
  await c.query(`grant anon, authenticated, service_role to authenticator`);
  await c.end();
}

/**
 * 向操作系统要一个当前空闲的端口（listen 0 再关掉）。
 * 旧实现是「随机起点 + 每次 +7」自己数号，不查占用：两个 worker 的序列会撞号（2026-10-28 并行压测实测：
 * PostgREST 绑定失败 Address already in use，而就绪检查被占着该端口的另一个 worker 的服务答复了，见
 * docs/audits/evidence/ci/admin-faults-flake-2026-10-28.md §4）。
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 起一个 PostgREST。opts.adminPort：同时开管理端口（/ready、/metrics），
 * 用 schemaCacheLoads() 读「结构缓存成功加载次数」——这是 PostgREST 自己的重载完成信号。
 */
export async function startPostgrest(
  dbName: string,
  port: number,
  opts: { adminPort?: number } = {},
): Promise<ChildProcess> {
  const u = new URL(dbUrl(dbName));
  u.username = 'authenticator';
  u.password = 'authenticator';
  // 本进程独有的标记：就绪检查要在 OpenAPI 里看到它，才算「答复的是我刚起的这个进程」，而不是端口上别的服务
  const marker = `pgrst-${randomUUID()}.invalid`;
  const logFd = process.env.PGRST_TEST_LOG
    ? openSync(`${process.env.PGRST_TEST_LOG}-${port}.log`, 'a')
    : null;
  const p = spawn(BIN!, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: u.toString(),
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_PORT: String(port),
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_OPENAPI_SERVER_PROXY_URI: `http://${marker}`,
      ...(opts.adminPort ? { PGRST_ADMIN_SERVER_PORT: String(opts.adminPort) } : {}),
      PGRST_LOG_LEVEL: process.env.PGRST_TEST_LOG ? 'info' : 'crit',
    },
    // PGRST_TEST_LOG=<文件前缀>：把每个 PostgREST 进程的日志写到 <前缀>-<端口>.log（排查结构重载等时序问题用）
    stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 150; i++) {
    // 进程已退出（如端口被占绑定失败）：立即报错，不能把端口上别的服务当成它
    if (p.exitCode !== null || p.signalCode !== null)
      throw new Error(`PostgREST 未能启动（进程已退出，退出码 ${p.exitCode ?? p.signalCode}，端口 ${port}）`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Authorization: `Bearer ${ANON}`, Accept: 'application/openapi+json' },
      });
      if (r.status < 500 && (await r.text()).includes(marker)) {
        if (!opts.adminPort) return p;
        const a = await fetch(`http://127.0.0.1:${opts.adminPort}/live`).catch(() => null);
        if (a?.ok && p.exitCode === null) return p;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error('PostgREST 未能启动');
}

/** PostgREST 管理端口上 pgrst_schema_cache_loads_total{status="SUCCESS"} 的当前值（结构缓存成功加载次数） */
export async function schemaCacheLoads(adminPort: number): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${adminPort}/metrics`)).text();
  const m = text.match(/^pgrst_schema_cache_loads_total\{status="SUCCESS"\}\s+([\d.e+]+)/m);
  if (!m) throw new Error('PostgREST /metrics 里没有 pgrst_schema_cache_loads_total{status="SUCCESS"}');
  return Number(m[1]);
}
