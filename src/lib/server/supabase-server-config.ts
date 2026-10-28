/** 服务端（Vercel Function）的 Supabase 配置：规则同 scripts/supabase-env.mjs，单独成模块，不进浏览器包。 */
import { SupabaseConfigError, resolveSupabaseConfig } from '../../../scripts/supabase-env.mjs';

/**
 * 服务端（Vercel Function 运行时）：读 process.env，含 VERCEL / VERCEL_ENV。
 * Preview 缺变量时抛 SupabaseConfigError（调用方返回 503），不会连生产库。
 */
export function serverSupabaseConfig(env: Record<string, string | undefined> = process.env): {
  url: string;
  key: string;
} {
  const { url, key } = resolveSupabaseConfig(env);
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
