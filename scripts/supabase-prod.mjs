/**
 * 生产 Supabase 项目的身份：只给 Node 侧用（astro.config.mjs 构建期判定、测试）。
 * 不要从 src/ 引用：浏览器 / Vercel Function 包只通过构建期注入的 PUBLIC_SUPABASE_PROD_REF 拿到生产 ref，
 * 且只有 VERCEL_ENV=production 的构建才注入（非生产构建产物里不出现生产 ref，tests/built/supabase-target.test.ts 扫描）。
 * publishable key 设计上就是公开的（权限由 RLS 决定）；这里只用来识别「非生产环境误填了生产 key」并拒绝，绝不作为默认值。
 */
export const PRODUCTION_REF = 'abryflgoljltyakthtql';
export const PRODUCTION_PUBLISHABLE_KEY = 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh';
/** @type {import('./supabase-env.mjs').ProductionIdentity} */
export const PRODUCTION_IDENTITY = Object.freeze({
  refs: Object.freeze([PRODUCTION_REF]),
  publishableKey: PRODUCTION_PUBLISHABLE_KEY,
});
