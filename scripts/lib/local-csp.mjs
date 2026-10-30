/**
 * 本机 / CI 静态服务器（scripts/serve.mjs）对 vercel.json CSP 的本地改写——线上 vercel.json 原样不变：
 *  1. 去掉 upgrade-insecure-requests（本地是 http，会把同源子资源升级成 https 而失败）；
 *  2. 构建显式指向本机栈（PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 之类，scripts/supabase-env.mjs 的允许清单）时，
 *     只把这个 loopback 源放进 connect-src（含 ws）与 img-src。测试项目 / 生产是 *.supabase.co，本来就在 CSP 里。
 * tests/e2e/security.spec.ts 用同一个函数算期望值，并断言除这两处外与 vercel.json 完全一致。
 */
import { localSupabaseOrigin } from '../supabase-env.mjs';

/** @param {string} csp @param {Record<string, string | undefined>} env */
export function localCsp(csp, env = process.env) {
  const out = csp.replace(/;\s*upgrade-insecure-requests\s*(?=;|$)/, '');
  const o = localSupabaseOrigin(env);
  if (!o) return out;
  return out
    .replace(/(connect-src [^;]*)/, `$1 ${o} ${o.replace(/^http/, 'ws')}`)
    .replace(/(img-src [^;]*)/, `$1 ${o}`);
}
