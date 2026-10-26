import type { APIRoute } from 'astro';
import { DEFAULT_SUPABASE } from '@/lib/data';
import { handleOneClickUnsubscribe } from '@/lib/server/subscribe';

/** Vercel Function：RFC 8058 一键退订（邮件头 List-Unsubscribe-Post），T9.15。 */
export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  handleOneClickUnsubscribe(request, process.env, { defaults: DEFAULT_SUPABASE });

export const ALL: APIRoute = ({ request }) =>
  handleOneClickUnsubscribe(request, process.env, { defaults: DEFAULT_SUPABASE });
