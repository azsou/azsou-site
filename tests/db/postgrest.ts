/** 本地 PostgREST（与生产同一大版本 14.x）：起进程、签 JWT。POSTGREST_BIN 未设置时相关测试跳过。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
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

let nextPort = 39000 + Math.floor(Math.random() * 3000) + (process.pid % 7) * 300;
export const freePort = () => (nextPort += 7);

export async function startPostgrest(dbName: string, port: number): Promise<ChildProcess> {
  const u = new URL(dbUrl(dbName));
  u.username = 'authenticator';
  u.password = 'authenticator';
  const p = spawn(BIN!, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: u.toString(),
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: SECRET,
      PGRST_SERVER_PORT: String(port),
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_LOG_LEVEL: 'crit',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/forum_threads?limit=1`, {
        headers: { Authorization: `Bearer ${ANON}` },
      });
      if (r.status < 500) return p;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error('PostgREST 未能启动');
}
