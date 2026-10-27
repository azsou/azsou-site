import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 前后台共享依赖拆分的构建期门禁（站长 2026-10-27 21:06：/apps/ JS 预算 49,152 B 不放宽，不靠重跑 / 推迟加载 / 挪采样窗口过关）。
 *
 * 读 astro.config.mjs 的 clientChunkManifest 写出的 dist/meta/client-chunks.json（每个客户端 chunk 实际打进了哪些源模块），
 * 对每个公开 HTML 页面，从页面上的模块脚本出发，沿静态 import 与动态 import() 走完整个闭包——
 * 也就是这个页面在任何交互下可能加载到的全部 JS——断言其中没有后台专用模块。
 * 这比 Lighthouse 只看「加载期间实际请求的脚本」更严：交互后才加载的 chunk 也不许带后台代码。
 *
 * 加载期间实际传输字节数（含空闲时加载的 island）由 tests/e2e/js-budget.spec.ts 在真实浏览器里对同一个 gzip 服务器测量。
 */
const DIST = 'dist/client';
const MANIFEST = 'dist/meta/client-chunks.json';
type Chunk = { modules: string[]; imports: string[]; dynamicImports: string[] };

/** 后台专用模块：只应出现在 /admin/ 与 /_kit/admin/（后台样张）的包里 */
const ADMIN_ONLY = [
  /^src\/scripts\/admin\//,
  /^src\/lib\/data\/(admin|admin-repo|admin-crm-api|schema-map)\.ts$/,
  /^src\/lib\/(admin-errors|settings-guard|admin-crm|admin-permissions|admin-shortcuts|admin-utils)\.ts$/,
];
const isAdminPage = (route: string) => /^\/(admin|_kit\/admin)\//.test(route);

const built = existsSync(MANIFEST) && existsSync(join(DIST, 'apps/index.html'));

function htmlRoutes(): string[] {
  return (readdirSync(DIST, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.html') && !f.startsWith('pagefind'))
    .map(
      (f) =>
        '/' +
        f
          .split('\\')
          .join('/')
          .replace(/index\.html$/, ''),
    );
}

function closure(route: string, chunks: Record<string, Chunk>): Set<string> {
  const file = join(DIST, route.endsWith('/') ? route + 'index.html' : route);
  const html = readFileSync(file, 'utf8');
  const start = new Set<string>();
  // 只看打包产物（/_astro/）；public/ 下原样拷贝的脚本（如 /cms/cms-ext.js）不经打包、不含 src 模块
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="\/(_astro\/[^"]+\.js)"/g))
    start.add(m[1]);
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g))
    for (const i of m[1].matchAll(/["']\/(_astro\/[^"']+\.js)["']/g)) start.add(i[1]);
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const f = posix.normalize(queue.pop()!);
    if (seen.has(f)) continue;
    seen.add(f);
    const c = chunks[f];
    expect(c, `${route} 引用的 ${f} 不在 chunk 清单里`).toBeTruthy();
    queue.push(...c.imports, ...c.dynamicImports);
  }
  return seen;
}

describe.skipIf(!built)('前后台 JS 拆分（构建产物）', () => {
  const chunks = built ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, Chunk>) : {};
  const adminModules = (files: Iterable<string>) =>
    [...files].flatMap((f) =>
      (chunks[f]?.modules ?? []).filter((m) => ADMIN_ONLY.some((r) => r.test(m))).map((m) => `${f} ← ${m}`),
    );

  it('清单有效：后台页面确实用到这些后台模块（防止规则写错而空过）', () => {
    const all = closure('/admin/content/', chunks);
    const mods = adminModules(all).join('\n');
    for (const m of ['src/lib/data/admin.ts', 'src/lib/data/admin-repo.ts', 'src/lib/admin-errors.ts'])
      expect(mods).toContain(m);
    expect(adminModules(closure('/admin/settings/', chunks)).join('\n')).toContain(
      'src/lib/settings-guard.ts',
    );
  });

  it('/apps/ 加载与交互可能用到的全部 chunk 都不含后台模块；数据层共享 chunk 只含数据层', () => {
    const all = closure('/apps/', chunks);
    expect(adminModules(all)).toEqual([]);
    const data = [...all].filter((f) => chunks[f].modules.includes('src/lib/data/supabase.ts'));
    expect(data).toHaveLength(1);
    expect(chunks[data[0]].modules.filter((m) => !/^src\/lib\/(data\/|images\.ts$)/.test(m))).toEqual([]);
  });

  it('所有公开页面（非 /admin/、非后台样张）的 chunk 闭包都不含后台模块', () => {
    const routes = htmlRoutes().filter((r) => !isAdminPage(r));
    expect(routes.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const r of routes) for (const x of adminModules(closure(r, chunks))) bad.push(`${r}: ${x}`);
    expect(bad).toEqual([]);
  });
});
