/** 构建期决定前端用哪个 Turnstile site key（公开值）。未配置时用 Cloudflare 官方「总是通过」测试 key。 */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

export function turnstileSiteKey(): string {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  return env.TURNSTILE_SITE_KEY || env.PUBLIC_TURNSTILE_SITE_KEY || TURNSTILE_TEST_SITE_KEY;
}
