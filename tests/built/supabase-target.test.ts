/**
 * 构建产物扫描（站长 2026-10-28 第五轮）：产物指向的 Supabase 必须就是构建时显式配置的那个，
 * 非生产构建（本机 / CI / Preview）的浏览器包与 Vercel Function 包里不得出现生产 ref 或生产 publishable key。
 * 在 npm run build 之后运行（CI build 任务的 test:ld 步骤），读的是真实产物，不 mock 任何东西。
 *
 * 只读一次：产物树 1400+ 个文本文件、~110 MB。原来每个用例各读一遍整棵树（默认 5 s 用例时限内做 I/O），
 * 网络盘冷缓存下单次可达 30–80 s。现在在 beforeAll 里读一次（显式钩子时限 LOAD_TIMEOUT_MS），
 * 用例只做内存里的字节子串匹配，仍是默认 5 s 时限。目录、文件过滤、needle 与断言均与原来一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveSupabaseConfig } from '../../scripts/supabase-env.mjs';
import {
  PRODUCTION_IDENTITY,
  PRODUCTION_PUBLISHABLE_KEY,
  PRODUCTION_REF,
} from '../../scripts/supabase-prod.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const DIRS = ['dist/client', '.vercel/output/static', '.vercel/output/functions', '.vercel/output/_functions']
  .map((d) => path.join(root, d))
  .filter((d) => fs.existsSync(d));
const TEXT = /\.(html|js|mjs|cjs|json|css|xml|txt|webmanifest|map)$/;

/** 读整棵产物树的钩子时限（CI SSD 上 < 2 s；本机网络盘冷缓存实测 30–80 s，留足余量）。 */
const LOAD_TIMEOUT_MS = 180_000;

type Entry = { rel: string; buf: Buffer };

function readTree(dirs: string[]): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (TEXT.test(e.name)) out.push({ rel: path.relative(root, p), buf: fs.readFileSync(p) });
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

/** 与原 scan() 同语义：返回 needle → 命中文件（相对仓库根）。按字节匹配 UTF-8 编码的 needle。 */
function scanEntries(entries: Entry[], needles: string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  const enc = needles.map((n) => [n, Buffer.from(n, 'utf8')] as const);
  for (const { rel, buf } of entries)
    for (const [n, b] of enc) if (buf.includes(b)) (hits[n] ??= []).push(rel);
  return hits;
}

let tree: Entry[] = [];
const scan = (needles: string[]) => scanEntries(tree, needles);

const cfg = resolveSupabaseConfig(process.env, PRODUCTION_IDENTITY);

describe('构建产物的 Supabase 目标', () => {
  beforeAll(() => {
    tree = readTree(DIRS);
  }, LOAD_TIMEOUT_MS);

  it('有产物可扫', () => {
    expect(DIRS.some((d) => d.endsWith(path.join('dist', 'client')))).toBe(true);
    expect(tree.length).toBeGreaterThan(0);
  });

  it('扫描器自检：注入的生产 ref / key 一定被报出（只读一次不会漏报）', () => {
    const fake: Entry[] = [
      { rel: 'dist/client/ok.js', buf: Buffer.from('const u = "http://127.0.0.1:54321";') },
      { rel: 'dist/client/bad.js', buf: Buffer.from(`fetch("https://${PRODUCTION_REF}.supabase.co")`) },
      {
        rel: 'dist/client/中文/bad.html',
        buf: Buffer.from(`<meta content="中文 ${PRODUCTION_PUBLISHABLE_KEY}">`),
      },
    ];
    expect(scanEntries(fake, [PRODUCTION_REF, PRODUCTION_PUBLISHABLE_KEY])).toEqual({
      [PRODUCTION_REF]: ['dist/client/bad.js'],
      [PRODUCTION_PUBLISHABLE_KEY]: ['dist/client/中文/bad.html'],
    });
  });

  it('浏览器包里出现的是构建时配置的地址', () => {
    const host = new URL(cfg.url).host;
    const hits = scan([host]);
    expect(hits[host]?.some((f) => f.startsWith('dist/client/'))).toBe(true);
  });

  it.runIf(cfg.target !== 'production')('非生产构建：产物里没有生产 ref / 生产 publishable key', () => {
    expect(scan([PRODUCTION_REF, PRODUCTION_PUBLISHABLE_KEY])).toEqual({});
  });

  it.runIf(cfg.target === 'production')('生产构建：产物里没有测试项目 / 本机栈地址', () => {
    expect(scan(['ovvfwkmqlejcpatmfqcd', '127.0.0.1:54321'])).toEqual({});
  });
});
