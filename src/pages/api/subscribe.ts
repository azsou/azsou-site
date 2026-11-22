import type { APIRoute } from 'astro';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { handleSubscribe } from '@/lib/server/subscribe';

/**
 * Vercel Function：邮件订阅（T7.8，双重确认）。Turnstile 服务端校验 → 票据 → 数据库 0016 → 发确认信。
 * 发信服务（Resend / SMTP）没配置时返回 503，不写库也不发信；见 docs/DEPLOY.md「邮件订阅」。
 */
export const prerender = false;

export const POST: APIRoute = ({ request, clientAddress }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleSubscribe(request, process.env, { defaults }, clientAddress);
};

export const ALL: APIRoute = ({ request }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleSubscribe(request, process.env, { defaults });
};
