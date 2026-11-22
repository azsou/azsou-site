import type { APIRoute } from 'astro';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { handleCommunitySubmit } from '@/lib/server/community-submit';

/** Vercel Function：留言（guestbook）/ 友链申请（link）——Turnstile 服务端校验后签票据，再调数据库 RPC（0015） */
export const prerender = false;

export const POST: APIRoute = ({ params, request, clientAddress }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleCommunitySubmit(params.kind, request, process.env, { defaults }, clientAddress);
};

export const ALL: APIRoute = ({ params, request }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleCommunitySubmit(params.kind, request, process.env, { defaults });
};
