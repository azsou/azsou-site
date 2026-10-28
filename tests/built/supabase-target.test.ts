/**
 * 构建产物扫描（站长 2026-10-28 第五轮）：产物指向的 Supabase 必须就是构建时显式配置的那个，
 * 非生产构建（本机 / CI / Preview）的浏览器包与 Vercel Function 包里不得出现生产 ref 或生产 publishable key。
 * 在 npm run build 之后运行（CI build 任务的 test:ld 步骤），读的是真实产物，不 mock 任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

function scan(needles: string[]): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (TEXT.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8');
        for (const n of needles) if (t.includes(n)) (hits[n] ??= []).push(path.relative(root, p));
      }
    }
  };
  for (const d of DIRS) walk(d);
  return hits;
}

const cfg = resolveSupabaseConfig(process.env, PRODUCTION_IDENTITY);

describe('构建产物的 Supabase 目标', () => {
  it('有产物可扫', () => {
    expect(DIRS.some((d) => d.endsWith(path.join('dist', 'client')))).toBe(true);
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
