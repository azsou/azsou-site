/**
 * Supabase 连接配置 fail-closed（站长 2026-10-28）：Vercel 非生产环境缺 PUBLIC_SUPABASE_URL / KEY 不得回退生产库。
 * 规则在 scripts/supabase-env.mjs；构建期检查见 supabase-build-guard.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRODUCTION_SUPABASE,
  SupabaseConfigError,
  resolveSupabaseConfig,
} from '../../scripts/supabase-env.mjs';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { supabaseConfig } from '@/lib/supabase-config';

const TEST = { url: 'https://ovvtestprojectref.supabase.co', key: 'sb_publishable_test' };
const both = { PUBLIC_SUPABASE_URL: TEST.url, PUBLIC_SUPABASE_KEY: TEST.key };

describe('resolveSupabaseConfig', () => {
  it.each([
    ['Vercel preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
    ['Vercel development', { VERCEL: '1', VERCEL_ENV: 'development' }],
    ['Vercel production', { VERCEL: '1', VERCEL_ENV: 'production' }],
    ['本机 / CI', {}],
  ])('%s：两个变量都设置时用 env', (_label, extra) => {
    expect(resolveSupabaseConfig({ ...extra, ...both })).toEqual({ ...TEST, source: 'env' });
  });

  it.each([
    ['preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
    ['development', { VERCEL: '1', VERCEL_ENV: 'development' }],
    ['VERCEL=1 但没有 VERCEL_ENV', { VERCEL: '1' }],
    ['只有 VERCEL_ENV=preview', { VERCEL_ENV: 'preview' }],
  ])('Vercel 非生产（%s）缺变量 → 报错，不回退生产', (_label, env) => {
    expect(() => resolveSupabaseConfig(env)).toThrow(SupabaseConfigError);
    expect(() => resolveSupabaseConfig(env)).toThrow(/非生产部署不会回退到生产 Supabase/);
  });

  it('空字符串 / 空白等同未设置（Vercel 里填了空值也不算配置）', () => {
    expect(() =>
      resolveSupabaseConfig({
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        PUBLIC_SUPABASE_URL: ' ',
        PUBLIC_SUPABASE_KEY: '',
      }),
    ).toThrow(SupabaseConfigError);
  });

  it.each([
    ['只有 URL', { PUBLIC_SUPABASE_URL: TEST.url }],
    ['只有 KEY', { PUBLIC_SUPABASE_KEY: TEST.key }],
  ])('%s → 任何环境都报错（防止测试 URL + 生产 key 混搭）', (_label, partial) => {
    for (const extra of [
      {},
      { VERCEL: '1', VERCEL_ENV: 'production' },
      { VERCEL: '1', VERCEL_ENV: 'preview' },
    ])
      expect(() => resolveSupabaseConfig({ ...extra, ...partial })).toThrow(/必须同时设置/);
  });

  it('Vercel 生产缺变量 → 受保护的生产默认值（并标明来源）', () => {
    expect(resolveSupabaseConfig({ VERCEL: '1', VERCEL_ENV: 'production' })).toEqual({
      ...PRODUCTION_SUPABASE,
      source: 'production-default',
    });
  });

  it('不在 Vercel（本机 / CI）缺变量 → 生产默认值，来源标为 local-default', () => {
    expect(resolveSupabaseConfig({}).source).toBe('local-default');
  });

  it('生产默认 key 是 publishable key，不是 secret / service_role', () => {
    expect(PRODUCTION_SUPABASE.key).toMatch(/^sb_publishable_/);
  });
});

describe('服务端：serverSupabaseConfig + 503', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('Preview 缺变量 → SupabaseConfigError → 503 service_not_configured（不连生产）', async () => {
    let err: unknown;
    try {
      serverSupabaseConfig({ VERCEL: '1', VERCEL_ENV: 'preview' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SupabaseConfigError);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = supabaseConfigErrorResponse(err);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'service_not_configured' });
  });

  it('非配置错误原样抛出', () => {
    expect(() => supabaseConfigErrorResponse(new Error('boom'))).toThrow('boom');
  });

  it('API 路由：Preview 缺变量时 /api/subscribe 返回 503，且没有向任何地址发请求', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('PUBLIC_SUPABASE_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/pages/api/subscribe');
    const res = await (POST as (ctx: unknown) => Promise<Response> | Response)({
      request: new Request('https://preview.example/api/subscribe', { method: 'POST', body: '{}' }),
      clientAddress: '127.0.0.1',
    });
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('API 路由：Preview 配了测试项目时用测试项目，不是生产', () => {
    expect(serverSupabaseConfig({ VERCEL: '1', VERCEL_ENV: 'preview', ...both })).toEqual(TEST);
  });
});

describe('浏览器端 supabaseConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('读构建期 PUBLIC_* 变量', () => {
    vi.stubEnv('PUBLIC_SUPABASE_URL', TEST.url);
    vi.stubEnv('PUBLIC_SUPABASE_KEY', TEST.key);
    expect(supabaseConfig()).toEqual(TEST);
  });

  it('只配了一个 → 报错', () => {
    vi.stubEnv('PUBLIC_SUPABASE_URL', TEST.url);
    vi.stubEnv('PUBLIC_SUPABASE_KEY', '');
    expect(() => supabaseConfig()).toThrow(/必须同时设置/);
  });
});

describe('源码里没有别处硬编码生产 Supabase', () => {
  it('生产 URL / key 只出现在 scripts/supabase-env.mjs', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const ref = new URL(PRODUCTION_SUPABASE.url).host.split('.')[0];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|js|mjs|astro|svelte)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (text.includes(ref) || text.includes(PRODUCTION_SUPABASE.key)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(hits).toEqual([]);
  });
});
