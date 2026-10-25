import type { APIRoute } from 'astro';
import { DEFAULT_SUPABASE } from '@/lib/data';
import { handleCommunitySubmit } from '@/lib/server/community-submit';

/** Vercel Function：留言（guestbook）/ 友链申请（link）——Turnstile 服务端校验后签票据，再调数据库 RPC（0015） */
export const prerender = false;

export const POST: APIRoute = ({ params, request, clientAddress }) =>
  handleCommunitySubmit(params.kind, request, process.env, { defaults: DEFAULT_SUPABASE }, clientAddress);

export const ALL: APIRoute = ({ params, request }) =>
  handleCommunitySubmit(params.kind, request, process.env, { defaults: DEFAULT_SUPABASE });
