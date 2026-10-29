import type { APIRoute } from 'astro';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { handleGuardedAuth } from '@/lib/server/guarded-auth';

/** Vercel Function：Turnstile 服务端校验后再转发注册 / 找回密码 / 重发确认邮件 */
export const prerender = false;

export const POST: APIRoute = ({ params, request, clientAddress }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleGuardedAuth(params.action, request, process.env, { defaults }, clientAddress);
};

export const ALL: APIRoute = ({ params, request }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleGuardedAuth(params.action, request, process.env, { defaults });
};
