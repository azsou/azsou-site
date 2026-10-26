import type { APIRoute } from 'astro';
import { getCatalog } from '@/lib/content';

/** 目录筛选的数据源（构建期生成的静态 JSON，浏览器端筛选 / 排序用） */
export const GET: APIRoute = async () =>
  new Response(JSON.stringify(await getCatalog()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
