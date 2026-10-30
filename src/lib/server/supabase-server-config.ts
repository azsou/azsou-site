/** 服务端（Vercel Function）的 Supabase 配置：规则同 scripts/supabase-env.mjs，单独成模块，不进浏览器包。 */
import { SupabaseConfigError, resolveSupabaseConfig } from '../../../scripts/supabase-env.mjs';
import { bundledProductionIdentity } from '../supabase-config';

/**
 * 服务端（Vercel Function 运行时）：每次请求读 process.env（含 VERCEL_ENV）重新判定——运行时检查，不只依赖构建期。
 * 缺配置 / 目标不在允许清单 / 非生产指向生产 / 生产部署指向非生产 → 抛 SupabaseConfigError（调用方返回 503，不发任何请求）。
 * 生产身份来自构建期注入（非生产构建为空）：即使运行时把 VERCEL_ENV 改成 production，非生产构建也连不了生产。
 */
export function serverSupabaseConfig(env: Record<string, string | undefined> = process.env): {
  url: string;
  key: string;
} {
  const { url, key } = resolveSupabaseConfig(env, bundledProductionIdentity());
  return { url, key };
}

/** 服务端配置缺失时统一的 503 响应（不暴露细节以外的信息；细节写日志） */
export function supabaseConfigErrorResponse(e: unknown): Response {
  if (!(e instanceof SupabaseConfigError)) throw e;
  console.error(`[supabase-config] ${e.message}`);
  return new Response(
    JSON.stringify({ error: 'service_not_configured', message: '服务未配置（Supabase 连接缺失）' }),
    {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}
