import { listRoutes } from '../../scripts/routes.mjs';
/** 构建产物里的全部 HTML 路由（先 npm run build） */
export const ROUTES: string[] = listRoutes('dist');
