/**
 * 用例里拦截 Supabase 请求的统一判定：任何 *.supabase.co，加上构建时显式配置的 PUBLIC_SUPABASE_URL 的源
 * （CI / 本机 = 本机栈 http://127.0.0.1:54321，scripts/supabase-env.mjs 没有默认值）。
 * 只按 supabase.co 拦截的话，指向本机栈的请求会真的发出去（连接被拒）；WebKit 会把这种失败报成
 * 「… due to access control checks.」页面错误，设备矩阵的「无脚本错误」断言就会失败——这不是应用错误，是用例漏拦。
 */
const configuredOrigin = (() => {
  const u = process.env.PUBLIC_SUPABASE_URL;
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
})();

export function isSupabaseUrl(url: URL): boolean {
  return (
    /(^|\.)supabase\.co$/.test(url.hostname) || (configuredOrigin !== null && url.origin === configuredOrigin)
  );
}

/** Supabase + 第三方（Turnstile、Google 广告 / 统计）：设计 / 设备 / 首帧用例一律中止，不依赖外部服务 */
export function isSupabaseOrThirdParty(url: URL): boolean {
  return (
    isSupabaseUrl(url) || /challenges\.cloudflare\.com|googlesyndication|googletagmanager/.test(url.href)
  );
}
