/**
 * Supabase 连接配置的唯一判定规则（fail-closed + 允许清单，站长 2026-10-28 第五轮）。
 * 被 astro.config.mjs（构建期检查）、src/lib/supabase-config.ts（浏览器端）、服务端 API 路由（运行时检查）、
 * scripts/serve.mjs（本机 / CI 服务器）与单元 / 构建期测试共用。纯 JS（无依赖）。说明见 docs/DEPLOY.md「Supabase 连接配置」。
 *
 * 规则（没有任何默认值、没有任何回退）：
 *  1. PUBLIC_SUPABASE_URL 与 PUBLIC_SUPABASE_KEY 必须同时显式设置；缺一个或两个都缺 → 报错（任何环境：本机、CI、Preview、生产）。
 *  2. 部署类别只看 VERCEL_ENV：
 *     - VERCEL_ENV === 'production' → 生产部署：URL 必须是生产项目（生产身份在 scripts/supabase-prod.mjs；打包代码只在生产构建里由构建期注入）。
 *     - 其他一切（Vercel preview / development、GitHub Actions、本机开发、单元测试、浏览器）→ 非生产：
 *       URL 必须在非生产允许清单里——隔离测试项目（TEST_PROJECT_REFS）或本机栈（localhost / 127.0.0.1 / [::1]）；
 *       生产项目、生产 publishable key、任何不在清单里的地址一律拒绝。
 *  3. key 永远不能是 secret / service_role（sb_secret_… 或 role=service_role 的 JWT）。
 *  4. 测试项目 / 生产项目必须是 https://<ref>.supabase.co（不带路径）；本机栈允许 http。
 */

/**
 * 生产项目的身份（ref + publishable key）不写在这个文件里：它会被打进浏览器 / Vercel Function 包，
 * 非生产构建的产物里不应出现生产 ref。身份在 scripts/supabase-prod.mjs，只由 Node 侧（astro.config.mjs、测试）读取；
 * 打包代码拿到的是构建期注入的 PUBLIC_SUPABASE_PROD_REF——只有 VERCEL_ENV=production 的构建才非空。
 * 没传身份 = 不允许任何生产项目（fail-closed）。
 * @typedef {{ refs?: readonly string[]; publishableKey?: string }} ProductionIdentity
 */
/** @type {ProductionIdentity} */
const NO_PRODUCTION = Object.freeze({ refs: Object.freeze([]), publishableKey: '' });

/** 非生产允许清单：隔离测试项目 azsou-test。新增测试项目必须改这里（代码审查），不能靠环境变量放行。 */
export const TEST_PROJECT_REFS = Object.freeze(['ovvfwkmqlejcpatmfqcd']);
/** 非生产允许清单：本机栈（本地 PostgREST / GoTrue / storage-api 或 supabase start）。 */
export const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

export class SupabaseConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/**
 * @typedef {{ PUBLIC_SUPABASE_URL?: string; PUBLIC_SUPABASE_KEY?: string; VERCEL?: string; VERCEL_ENV?: string; [name: string]: string | undefined }} SupabaseEnv
 *   其余环境变量（CI、GITHUB_ACTIONS 等）允许存在但不参与判定——索引签名让 process.env / 任意 env 对象都能直接传入。
 * @typedef {'production' | 'test' | 'local'} SupabaseTarget
 */

/**
 * 判断一个 Supabase 地址属于哪一类；不在任何允许清单里返回 null。
 * @param {string} raw
 * @param {ProductionIdentity} [production]
 * @returns {{ target: SupabaseTarget; ref: string | null } | null}
 */
export function classifySupabaseUrl(raw, production = NO_PRODUCTION) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    return null;
  if (LOCAL_HOSTS.includes(u.hostname)) {
    return u.protocol === 'http:' || u.protocol === 'https:' ? { target: 'local', ref: null } : null;
  }
  const m = /^([a-z]{20})\.supabase\.co$/.exec(u.hostname);
  if (!m || u.protocol !== 'https:' || u.port) return null;
  if (TEST_PROJECT_REFS.includes(m[1])) return { target: 'test', ref: m[1] };
  if ((production.refs ?? []).includes(m[1])) return { target: 'production', ref: m[1] };
  return null;
}

/** key 是否像 secret / service_role（绝不能进前端或这里） */
export function isSecretLikeKey(key) {
  if (/^sb_secret_/i.test(key)) return true;
  if (/^eyJ/.test(key)) {
    try {
      const part = key.split('.')[1] ?? '';
      const json = JSON.parse(
        typeof globalThis.atob === 'function'
          ? globalThis.atob(part.replace(/-/g, '+').replace(/_/g, '/'))
          : Buffer.from(part, 'base64url').toString('utf8'),
      );
      return json?.role === 'service_role';
    } catch {
      return false;
    }
  }
  return false;
}

/** @param {SupabaseEnv} env */
export function isProductionDeploy(env = {}) {
  return env.VERCEL_ENV === 'production';
}

/**
 * @typedef {'missing' | 'secret-key' | 'production-requires-production' | 'not-allowlisted' | 'non-production-to-production'} SupabaseConfigFault
 */

/**
 * 判定本体（不拼报错文案）：浏览器包只引这个，长篇中文说明留在 Node / 服务端的 resolveSupabaseConfig，
 * 不进前台 JS（/apps/ 首屏 JS 预算 49,152 B）。规则只有这一份，resolveSupabaseConfig 也是调它。
 * @param {SupabaseEnv} [env]
 * @param {ProductionIdentity} [production]
 * @returns {{ ok: true; url: string; key: string; target: SupabaseTarget } | { ok: false; fault: SupabaseConfigFault; url: string; key: string; prod: boolean }}
 */
export function checkSupabaseConfig(env = {}, production = NO_PRODUCTION) {
  const url = (env.PUBLIC_SUPABASE_URL ?? '').trim();
  const key = (env.PUBLIC_SUPABASE_KEY ?? '').trim();
  const prod = isProductionDeploy(env);
  /** @param {SupabaseConfigFault} fault */
  const fail = (fault) => ({ ok: /** @type {const} */ (false), fault, url, key, prod });
  if (!url || !key) return fail('missing');
  if (isSecretLikeKey(key)) return fail('secret-key');
  const c = classifySupabaseUrl(url, production);
  if (prod) {
    if (!c || c.target !== 'production') return fail('production-requires-production');
    return {
      ok: /** @type {const} */ (true),
      url,
      key,
      target: /** @type {SupabaseTarget} */ ('production'),
    };
  }
  if (!c) return fail('not-allowlisted');
  if (c.target === 'production' || (production.publishableKey && key === production.publishableKey))
    return fail('non-production-to-production');
  return { ok: /** @type {const} */ (true), url, key, target: c.target };
}

/**
 * @param {SupabaseEnv} [env]
 * @param {ProductionIdentity} [production] 生产身份（Node 侧传 scripts/supabase-prod.mjs；打包代码传构建期注入值；不传 = 不允许生产）
 * @returns {{ url: string; key: string; source: 'env'; target: SupabaseTarget }}
 */
export function resolveSupabaseConfig(env = {}, production = NO_PRODUCTION) {
  const r = checkSupabaseConfig(env, production);
  if (r.ok) return { url: r.url, key: r.key, source: 'env', target: r.target };
  const { url, key, prod } = r;
  const where = prod
    ? 'Vercel 生产'
    : env.VERCEL_ENV
      ? `Vercel「${env.VERCEL_ENV}」`
      : '非生产（本机 / CI / 测试）';
  switch (r.fault) {
    case 'missing': {
      const missing = [!url && 'PUBLIC_SUPABASE_URL', !key && 'PUBLIC_SUPABASE_KEY']
        .filter(Boolean)
        .join('、');
      throw new SupabaseConfigError(
        `${where}环境缺少 ${missing}：Supabase 连接必须显式配置，没有默认值，也绝不回退到生产库` +
          '（PUBLIC_SUPABASE_URL 与 PUBLIC_SUPABASE_KEY 必须同时设置；docs/DEPLOY.md「Supabase 连接配置」）。',
      );
    }
    case 'secret-key':
      throw new SupabaseConfigError(
        'PUBLIC_SUPABASE_KEY 是 secret / service_role key：拒绝使用，只能填 publishable / anon key。',
      );
    case 'production-requires-production':
      throw new SupabaseConfigError(
        `Vercel 生产部署只能连生产项目（生产允许清单${(production.refs ?? []).length ? '' : '为空：本构建没有注入生产身份'}）：PUBLIC_SUPABASE_URL 不在清单里。`,
      );
    case 'not-allowlisted':
      throw new SupabaseConfigError(
        `${where}环境的 PUBLIC_SUPABASE_URL 不在非生产允许清单里（测试项目 ${TEST_PROJECT_REFS.join('、')} 或本机 ` +
          `${LOCAL_HOSTS.join(' / ')}）：拒绝连接。`,
      );
    default:
      throw new SupabaseConfigError(
        `${where}环境指向了生产 Supabase：非生产环境（Preview / 本机 / CI）绝不连生产库。`,
      );
  }
}

/**
 * 本机栈的 Supabase 源（http://127.0.0.1:54321 之类），供 scripts/serve.mjs 在本机 / CI 的 CSP 里放行；
 * 不是本机栈（测试项目 / 生产 / 未配置 / 非法）返回 null。
 * @param {SupabaseEnv} env
 */
export function localSupabaseOrigin(env = {}) {
  const url = (env.PUBLIC_SUPABASE_URL ?? '').trim();
  const c = url ? classifySupabaseUrl(url) : null;
  return c?.target === 'local' ? new URL(url).origin : null;
}
