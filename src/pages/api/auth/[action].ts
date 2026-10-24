import type { APIRoute } from 'astro';
import { DEFAULT_SUPABASE } from '@/lib/data';
import { handleGuardedAuth } from '@/lib/server/guarded-auth';

/** Vercel Function：Turnstile 服务端校验后再转发注册 / 找回密码 / 重发确认邮件 */
export const prerender = false;

export const POST: APIRoute = ({ params, request, clientAddress }) =>
  handleGuardedAuth(params.action, request, process.env, { defaults: DEFAULT_SUPABASE }, clientAddress);

export const ALL: APIRoute = ({ params, request }) =>
  handleGuardedAuth(params.action, request, process.env, { defaults: DEFAULT_SUPABASE });
