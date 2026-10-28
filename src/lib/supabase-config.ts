/**
 * Supabase 连接配置（无依赖的小模块：公告条等轻量脚本只引这个，不引整个数据层）。
 * 判定规则在 scripts/supabase-env.mjs（fail-closed：Vercel 非生产环境缺配置时构建失败、服务端报错，绝不回退生产库）。
 */
import {
  PRODUCTION_SUPABASE,
  SupabaseConfigError,
  resolveSupabaseConfig,
} from '../../scripts/supabase-env.mjs';

export { PRODUCTION_SUPABASE, SupabaseConfigError, resolveSupabaseConfig };

/**
 * 浏览器端 / 预渲染：读构建期替换进来的 PUBLIC_* 变量。
 * 浏览器拿不到 VERCEL_ENV（非 PUBLIC_ 变量不会进客户端包），所以这里的回退只在「构建期检查已通过」时才可能发生：
 * Vercel 非生产环境缺变量时 astro.config.mjs 已让构建失败，产物里不会出现生产默认值。
 */
export function supabaseConfig(): { url: string; key: string } {
  const env = import.meta.env ?? {};
  const { url, key } = resolveSupabaseConfig({
    PUBLIC_SUPABASE_URL: env.PUBLIC_SUPABASE_URL as string | undefined,
    PUBLIC_SUPABASE_KEY: env.PUBLIC_SUPABASE_KEY as string | undefined,
  });
  return { url, key };
}
