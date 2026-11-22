import type { APIRoute } from 'astro';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { handleOneClickUnsubscribe } from '@/lib/server/subscribe';

/** Vercel Function：RFC 8058 一键退订（邮件头 List-Unsubscribe-Post），T9.15。 */
export const prerender = false;

export const POST: APIRoute = ({ request }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleOneClickUnsubscribe(request, process.env, { defaults });
};

export const ALL: APIRoute = ({ request }) => {
  let defaults;
  try {
    defaults = serverSupabaseConfig();
  } catch (e) {
    return supabaseConfigErrorResponse(e);
  }
  return handleOneClickUnsubscribe(request, process.env, { defaults });
};
