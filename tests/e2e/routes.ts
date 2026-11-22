import { listRoutes } from '../../scripts/routes.mjs';

/**
 * 构建产物里的全部 HTML 路由（先 npm run build）。
 * 标签页（T7.2，100+ 个）是同一个模板：逐页检查只取前 3 个（按路径排序），其余由
 * tests/unit/tags.test.ts（数量 / 名称）与链接检查（test:links）覆盖，避免 E2E 时间翻倍。
 */
const all: string[] = listRoutes('dist/client');
const tagPages = all.filter((r) => /^\/tags\/[^/]+\/$/.test(r));
export const ROUTES: string[] = all.filter((r) => !tagPages.includes(r) || tagPages.indexOf(r) < 3);
