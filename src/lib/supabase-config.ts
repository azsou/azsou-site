/** Supabase 连接配置（无依赖的小模块：公告条等轻量脚本只引这个，不引整个数据层）。 */
export const DEFAULT_SUPABASE = {
  url: 'https://abryflgoljltyakthtql.supabase.co',
  // publishable key：设计上就是公开的，权限由数据库 RLS 决定
  key: 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh',
};

export function supabaseConfig() {
  const env = import.meta.env ?? {};
  return {
    url: (env.PUBLIC_SUPABASE_URL as string) || DEFAULT_SUPABASE.url,
    key: (env.PUBLIC_SUPABASE_KEY as string) || DEFAULT_SUPABASE.key,
  };
}
