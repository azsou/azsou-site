/** 从构建产物枚举全部 HTML 路由（E2E、链接检查、体积报告共用） */
import fs from 'node:fs';
import path from 'node:path';

export function listRoutes(dir = 'dist/client') {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        const rel = '/' + path.relative(dir, p).replace(/\\/g, '/');
        out.push(rel === '/404.html' ? rel : rel.replace(/index\.html$/, ''));
      }
    }
  };
  walk(dir);
  return out.sort();
}
