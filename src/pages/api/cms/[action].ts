import type { APIRoute } from 'astro';
import { handleCmsOAuth } from '@/lib/server/cms-oauth';

/** Vercel Function：内容后台（Decap CMS）的 GitHub OAuth（T7.7）。/api/cms/auth 与 /api/cms/callback */
export const prerender = false;

export const GET: APIRoute = ({ params, request }) => handleCmsOAuth(params.action, request, process.env);
export const ALL: APIRoute = ({ params, request }) => handleCmsOAuth(params.action, request, process.env);
