/**
 * I01（a）官方测试密钥回归用的本地 GoTrue（Supabase Auth 官方发布的二进制，不是假实现）。
 *
 * - 二进制：GOTRUE_BIN 指定；否则按 CPU 架构从 github.com/supabase/auth 的 Release 下载到 node_modules/.cache/gotrue/<版本>/。
 * - 数据库：DATABASE_URL 所在集群里的一个临时库（auth schema 由 GoTrue 自己的迁移建出）。
 * - 只用本地生成的测试 JWT 密钥与 Cloudflare 官方公开测试密钥；不连任何 Supabase 云项目。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ADMIN_URL, ROOT, dbUrl } from './helpers';

export const GOTRUE_VERSION = 'v2.197.0';
/** 只在本地测试库里用的 JWT 签名密钥（公开写在仓库里，不对应任何真实环境） */
export const LOCAL_JWT_SECRET = 'i01-local-gotrue-jwt-secret-not-used-anywhere-else-000';

export function gotrueBinary(): string {
  if (process.env.GOTRUE_BIN) return process.env.GOTRUE_BIN;
  const dir = join(ROOT, 'node_modules/.cache/gotrue', GOTRUE_VERSION);
  const bin = join(dir, 'auth');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const asset =
    process.arch === 'arm64'
      ? { name: `auth-${GOTRUE_VERSION}-arm64.tar.gz`, flag: 'z' }
      : { name: `auth-${GOTRUE_VERSION}-amd64.tar.xz`, flag: 'J' };
  const url = `https://github.com/supabase/auth/releases/download/${GOTRUE_VERSION}/${asset.name}`;
  execFileSync('bash', ['-c', `curl -fsSL --retry 3 -m 180 "${url}" | tar -x${asset.flag} -C "${dir}"`], {
    stdio: 'inherit',
  });
  if (!existsSync(bin)) throw new Error(`GoTrue 下载后找不到 ${bin}`);
  return bin;
}

/** 建一个只有空 auth schema 的临时库，跑一次 GoTrue 自己的迁移 */
export async function prepareAuthDb(name: string, bin: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const c = new pg.Client({ connectionString: dbUrl(name) });
  await c.connect();
  try {
    await c.query('create schema if not exists auth');
    // GoTrue 迁移里有 grant ... to postgres；CI 的 postgres 容器与本地 initdb -U postgres 都有这个角色
    await c.query(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres; end if; end $$`,
    );
  } finally {
    await c.end();
  }
  execFileSync(bin, ['migrate'], { env: gotrueEnv(name, 0, {}), stdio: 'pipe' });
  return name;
}

function authDbUrl(name: string) {
  const u = new URL(dbUrl(name));
  u.searchParams.set('sslmode', 'disable');
  u.searchParams.set('search_path', 'auth');
  return u.toString();
}

export interface GotrueOpts {
  /** GOTRUE_SECURITY_CAPTCHA_SECRET（Cloudflare 官方测试 secret）；不给则不开验证码 */
  captchaSecret?: string;
  siteUrl?: string;
  allowList?: string;
  /** GOTRUE_MAILER_AUTOCONFIRM（默认 true）；false = 证明「不靠邮件也能确认」的路径（Admin API email_confirm） */
  autoconfirm?: boolean;
}

function gotrueEnv(db: string, port: number, o: GotrueOpts): NodeJS.ProcessEnv {
  const site = o.siteUrl ?? 'http://127.0.0.1:4821';
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // 沙箱 / 公司网络的代理变量原样传给 GoTrue（它要访问 challenges.cloudflare.com）；本地地址不走代理
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(https?|all)_proxy$/i.test(k))),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    GOTRUE_API_HOST: '127.0.0.1',
    PORT: String(port),
    API_EXTERNAL_URL: `http://127.0.0.1:${port}`,
    GOTRUE_DB_DRIVER: 'postgres',
    DATABASE_URL: authDbUrl(db),
    GOTRUE_DB_NAMESPACE: 'auth',
    GOTRUE_JWT_SECRET: LOCAL_JWT_SECRET,
    GOTRUE_JWT_EXP: '3600',
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_SITE_URL: site,
    GOTRUE_URI_ALLOW_LIST: o.allowList ?? `${site}/auth/callback/**`,
    GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_MAILER_AUTOCONFIRM: o.autoconfirm === false ? 'false' : 'true',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true',
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: '0',
    GOTRUE_RATE_LIMIT_HEADER: 'X-Test-Client',
    GOTRUE_LOG_LEVEL: 'warn',
    ...(o.captchaSecret
      ? {
          GOTRUE_SECURITY_CAPTCHA_ENABLED: 'true',
          GOTRUE_SECURITY_CAPTCHA_PROVIDER: 'turnstile',
          GOTRUE_SECURITY_CAPTCHA_SECRET: o.captchaSecret,
        }
      : {}),
  };
}

export interface Gotrue {
  url: string;
  stop(): Promise<void>;
}

export async function startGotrue(
  bin: string,
  db: string,
  port: number,
  o: GotrueOpts = {},
): Promise<Gotrue> {
  const child: ChildProcess = spawn(bin, ['serve'], {
    env: gotrueEnv(db, port, o),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-4000)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`GoTrue 启动失败（退出码 ${child.exitCode}）：${stderr}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error(`GoTrue 10 秒内没有就绪：${stderr}`);
  }
  return {
    url,
    stop: () =>
      new Promise((res) => {
        if (child.exitCode !== null) return res();
        child.once('exit', () => res());
        child.kill('SIGTERM');
      }),
  };
}

/** 用本地测试 JWT 密钥签 HS256（service_role 调 admin 接口、构造过期 token） */
export function signJwt(claims: Record<string, unknown>, secret = LOCAL_JWT_SECRET): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
