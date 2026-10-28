/**
 * Supabase 连接配置的唯一判定规则（fail-closed，站长 2026-10-28 要求）。
 * 被 astro.config.mjs（构建期检查）、src/lib/supabase-config.ts（浏览器端）、服务端 API 路由与单元测试共用。
 * 纯 JS（无依赖）：astro.config.mjs 与 node 脚本可以直接 import。说明见 docs/DEPLOY.md「Supabase 连接配置」。
 *
 * 规则：
 *  1. PUBLIC_SUPABASE_URL 与 PUBLIC_SUPABASE_KEY 都设置 → 用它们（任何环境；生产也应走这条）。
 *  2. 只设置了其中一个 → 一律报错（防止「测试项目 URL + 生产 key」或反过来的混搭）。
 *  3. 都没设置：
 *     - Vercel 上且 VERCEL_ENV !== 'production'（preview / development / 未知）→ 报错，构建失败，绝不回退生产库；
 *     - Vercel 生产（VERCEL_ENV === 'production'）→ 允许受保护的生产默认值（下面的 PRODUCTION_SUPABASE，
 *       只是 env 漏配时的兜底；正式做法是在 Vercel Production 环境显式配置这两个变量）；
 *     - 不在 Vercel（本机开发、GitHub Actions CI、单元测试）→ 仍用生产默认值（这些环境的 E2E 会把 /rest/v1、/auth/v1
 *       路由到本地 PostgREST 或桩，不会真正写生产库）。这是已知的剩余项，见 docs/DEPLOY.md。
 */

/** 生产项目（abryflgoljltyakthtql）。publishable key 设计上就是公开的，权限由数据库 RLS 决定；绝不能是 secret / service_role。 */
export const PRODUCTION_SUPABASE = Object.freeze({
  url: 'https://abryflgoljltyakthtql.supabase.co',
  key: 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh',
});

export class SupabaseConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/**
 * @typedef {{ PUBLIC_SUPABASE_URL?: string; PUBLIC_SUPABASE_KEY?: string; VERCEL?: string; VERCEL_ENV?: string }} SupabaseEnv
 * @typedef {'env' | 'production-default' | 'local-default'} SupabaseConfigSource
 */

/**
 * @param {SupabaseEnv} [env]
 * @returns {{ url: string; key: string; source: SupabaseConfigSource }}
 */
export function resolveSupabaseConfig(env = {}) {
  const url = (env.PUBLIC_SUPABASE_URL ?? '').trim();
  const key = (env.PUBLIC_SUPABASE_KEY ?? '').trim();
  if (url && key) return { url, key, source: 'env' };
  if (url || key)
    throw new SupabaseConfigError(
      `Supabase 配置不完整：PUBLIC_SUPABASE_URL 与 PUBLIC_SUPABASE_KEY 必须同时设置（现在只设置了 ${url ? 'PUBLIC_SUPABASE_URL' : 'PUBLIC_SUPABASE_KEY'}）。`,
    );
  const onVercel = Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
  if (onVercel && env.VERCEL_ENV !== 'production')
    throw new SupabaseConfigError(
      `Vercel「${env.VERCEL_ENV || '未知'}」环境缺少 PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_KEY：` +
        '非生产部署不会回退到生产 Supabase。请在 Vercel 项目设置里为该环境配置隔离测试项目的 URL 与 publishable key' +
        '（docs/DEPLOY.md「Supabase 连接配置」）。',
    );
  return { ...PRODUCTION_SUPABASE, source: onVercel ? 'production-default' : 'local-default' };
}
