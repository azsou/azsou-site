/**
 * Supabase 连接配置（无依赖的小模块：公告条等轻量脚本只引这个，不引整个数据层）。
 * 判定规则在 scripts/supabase-env.mjs（必须显式配置 + 允许清单：非生产只能连测试项目 / 本机栈，生产部署只能连生产项目，没有默认值）。
 */
import {
  SupabaseConfigError,
  checkSupabaseConfig,
  classifySupabaseUrl as classifyWith,
  resolveSupabaseConfig,
  type ProductionIdentity,
} from '../../scripts/supabase-env.mjs';

export { SupabaseConfigError, resolveSupabaseConfig };

/**
 * 打包代码（浏览器 / Vercel Function）里的生产身份：构建期注入的 PUBLIC_SUPABASE_PROD_REF。
 * 只有 VERCEL_ENV=production 的构建才非空；其余构建（Preview、本机、CI、单元测试）是空 → 任何生产地址都不放行。
 */
export function bundledProductionIdentity(): ProductionIdentity {
  const ref = (import.meta.env?.PUBLIC_SUPABASE_PROD_REF as string | undefined) ?? '';
  return { refs: ref ? [ref] : [] };
}

export function classifySupabaseUrl(raw: string) {
  return classifyWith(raw, bundledProductionIdentity());
}

/**
 * 浏览器端 / 预渲染：读构建期替换进来的 PUBLIC_* 变量，再按同一允许清单校验一次（checkSupabaseConfig，与构建期 / 服务端同一规则）。
 * 浏览器拿不到 VERCEL_ENV：生产构建以「注入了生产身份」为准；非生产构建的包即使被塞进生产地址也会拒绝。
 * 报错只带判定代码：完整中文说明在构建期 / 服务端（resolveSupabaseConfig），不进前台 JS 预算。
 */
export function supabaseConfig(): { url: string; key: string } {
  const env = import.meta.env ?? {};
  const production = bundledProductionIdentity();
  const r = checkSupabaseConfig(
    {
      PUBLIC_SUPABASE_URL: env.PUBLIC_SUPABASE_URL as string | undefined,
      PUBLIC_SUPABASE_KEY: env.PUBLIC_SUPABASE_KEY as string | undefined,
      VERCEL_ENV: production.refs?.length ? 'production' : undefined,
    },
    production,
  );
  if (!r.ok) throw new SupabaseConfigError(`Supabase 配置不合规（${r.fault}），拒绝连接`);
  return { url: r.url, key: r.key };
}
