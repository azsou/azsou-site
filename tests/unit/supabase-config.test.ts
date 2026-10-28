/**
 * Supabase 连接配置：必须显式配置 + 允许清单（站长 2026-10-28 第五轮）。
 * 规则在 scripts/supabase-env.mjs；构建期（真实 astro.config.mjs 子进程）见 supabase-build-guard.test.ts，
 * 真实构建产物见 tests/built/supabase-target.test.ts。这里测解析规则本身、服务端运行时 503 与浏览器端再校验——
 * 不拦截网络：断言的是配置解析的结果 / 抛错，以及路由在解析失败时根本不发请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_HOSTS,
  SupabaseConfigError,
  TEST_PROJECT_REFS,
  checkSupabaseConfig,
  classifySupabaseUrl,
  localSupabaseOrigin,
  resolveSupabaseConfig,
} from '../../scripts/supabase-env.mjs';
import {
  PRODUCTION_IDENTITY as PI,
  PRODUCTION_PUBLISHABLE_KEY,
  PRODUCTION_REF,
} from '../../scripts/supabase-prod.mjs';
import { serverSupabaseConfig, supabaseConfigErrorResponse } from '@/lib/server/supabase-server-config';
import { bundledProductionIdentity, supabaseConfig } from '@/lib/supabase-config';

const TEST = { url: 'https://ovvfwkmqlejcpatmfqcd.supabase.co', key: 'sb_publishable_test' };
const LOCAL = { url: 'http://127.0.0.1:54321', key: 'sb_publishable_local' };
const PROD = { url: `https://${PRODUCTION_REF}.supabase.co`, key: PRODUCTION_PUBLISHABLE_KEY };
const env = (c: { url: string; key: string }) => ({ PUBLIC_SUPABASE_URL: c.url, PUBLIC_SUPABASE_KEY: c.key });
const NONPROD = [
  ['本机 / CI（无 VERCEL_*）', {}],
  ['Vercel preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
  ['Vercel development', { VERCEL: '1', VERCEL_ENV: 'development' }],
  ['VERCEL=1 但没有 VERCEL_ENV', { VERCEL: '1' }],
  ['GitHub Actions', { CI: 'true', GITHUB_ACTIONS: 'true' }],
] as const;
const PRODENV = { VERCEL: '1', VERCEL_ENV: 'production' };

describe('允许清单常量', () => {
  it('测试项目只有 azsou-test；本机只有 loopback', () => {
    expect(TEST_PROJECT_REFS).toEqual(['ovvfwkmqlejcpatmfqcd']);
    expect(LOCAL_HOSTS).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(PRODUCTION_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
  });

  it.each([
    [TEST.url, 'test'],
    [`${TEST.url}/`, 'test'],
    [PROD.url, 'production'],
    [LOCAL.url, 'local'],
    ['http://localhost:54321', 'local'],
    ['http://[::1]:54321', 'local'],
  ])('classify %s → %s', (url, target) => {
    expect(classifySupabaseUrl(url, PI)?.target).toBe(target);
  });

  it.each([
    'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', // 不在清单里的 Supabase 项目
    'http://ovvfwkmqlejcpatmfqcd.supabase.co', // 测试项目必须 https
    'https://ovvfwkmqlejcpatmfqcd.supabase.co:8443',
    'https://ovvfwkmqlejcpatmfqcd.supabase.co/rest/v1',
    'https://ovvfwkmqlejcpatmfqcd.supabase.co.evil.example',
    'https://user:pw@ovvfwkmqlejcpatmfqcd.supabase.co',
    'http://10.0.0.5:54321', // 局域网不算本机栈
    'http://127.0.0.1.nip.io:54321',
    'ftp://127.0.0.1',
    'not a url',
  ])('不在清单里：%s', (url) => {
    expect(classifySupabaseUrl(url, PI)).toBeNull();
  });

  it('不传生产身份（打包代码的非生产构建）→ 生产地址也不在任何清单里', () => {
    expect(classifySupabaseUrl(PROD.url)).toBeNull();
    expect(bundledProductionIdentity()).toEqual({ refs: [] });
  });
});

describe('resolveSupabaseConfig：没有任何默认值', () => {
  it.each([...NONPROD, ['Vercel production', PRODENV]] as const)('%s：两个都缺 → 报错', (_l, e) => {
    expect(() => resolveSupabaseConfig(e, PI)).toThrow(SupabaseConfigError);
    expect(() => resolveSupabaseConfig(e, PI)).toThrow(/没有默认值，也绝不回退到生产库/);
  });

  it.each([
    ['只有 URL', { PUBLIC_SUPABASE_URL: TEST.url }],
    ['只有 KEY', { PUBLIC_SUPABASE_KEY: TEST.key }],
    ['空白', { PUBLIC_SUPABASE_URL: ' ', PUBLIC_SUPABASE_KEY: '' }],
  ])('%s → 任何环境都报错', (_l, partial) => {
    for (const extra of [{}, PRODENV, { VERCEL: '1', VERCEL_ENV: 'preview' }])
      expect(() => resolveSupabaseConfig({ ...extra, ...partial }, PI)).toThrow(SupabaseConfigError);
  });
});

describe('resolveSupabaseConfig：非生产只能连测试项目 / 本机栈', () => {
  it.each(NONPROD)('%s：测试项目 → test', (_l, e) => {
    expect(resolveSupabaseConfig({ ...e, ...env(TEST) }, PI)).toEqual({
      ...TEST,
      source: 'env',
      target: 'test',
    });
  });
  it.each(NONPROD)('%s：本机栈 → local', (_l, e) => {
    expect(resolveSupabaseConfig({ ...e, ...env(LOCAL) }, PI)).toEqual({
      ...LOCAL,
      source: 'env',
      target: 'local',
    });
  });
  it.each(NONPROD)('%s：生产项目 → 拒绝', (_l, e) => {
    expect(() => resolveSupabaseConfig({ ...e, ...env(PROD) }, PI)).toThrow(/绝不连生产库/);
    // 不传身份时同样拒绝（不在清单里）
    expect(() => resolveSupabaseConfig({ ...e, ...env(PROD) })).toThrow(/不在非生产允许清单里/);
  });
  it.each(NONPROD)('%s：测试 URL + 生产 key → 拒绝', (_l, e) => {
    expect(() => resolveSupabaseConfig({ ...e, ...env({ url: TEST.url, key: PROD.key }) }, PI)).toThrow(
      /绝不连生产库/,
    );
  });
  it.each(NONPROD)('%s：清单外的项目 → 拒绝', (_l, e) => {
    expect(() =>
      resolveSupabaseConfig(
        { ...e, ...env({ url: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', key: 'k' }) },
        PI,
      ),
    ).toThrow(/不在非生产允许清单里/);
  });
});

describe('resolveSupabaseConfig：生产部署必须 VERCEL_ENV=production + 显式生产变量', () => {
  it('VERCEL_ENV=production + 生产变量 → production', () => {
    expect(resolveSupabaseConfig({ ...PRODENV, ...env(PROD) }, PI)).toEqual({
      ...PROD,
      source: 'env',
      target: 'production',
    });
  });
  it.each([
    ['测试项目', TEST],
    ['本机栈', LOCAL],
  ])('VERCEL_ENV=production 连 %s → 拒绝', (_l, c) => {
    expect(() => resolveSupabaseConfig({ ...PRODENV, ...env(c) }, PI)).toThrow(/只能连生产项目/);
  });
  it('只有 VERCEL=1（无 VERCEL_ENV）不算生产', () => {
    expect(() => resolveSupabaseConfig({ VERCEL: '1', ...env(PROD) }, PI)).toThrow(/绝不连生产库/);
  });
  it('没有注入生产身份的构建（非生产构建）即使 VERCEL_ENV=production 也连不了生产', () => {
    expect(() => resolveSupabaseConfig({ ...PRODENV, ...env(PROD) })).toThrow(/没有注入生产身份/);
  });
});

describe('secret / service_role key 永远拒绝', () => {
  const jwt = (role: string) =>
    `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref: 'ovvfwkmqlejcpatmfqcd' })).toString('base64url')}.sig`;
  it.each([
    ['sb_secret_', 'sb_secret_abc'],
    ['service_role JWT', jwt('service_role')],
  ])('%s', (_l, key) => {
    expect(() => resolveSupabaseConfig({ ...env({ url: TEST.url, key }) }, PI)).toThrow(
      /secret \/ service_role/,
    );
    expect(() => resolveSupabaseConfig({ ...PRODENV, ...env({ url: PROD.url, key }) }, PI)).toThrow(/secret/);
  });
  it('anon JWT 允许', () => {
    expect(resolveSupabaseConfig(env({ url: TEST.url, key: jwt('anon') })).target).toBe('test');
  });
});

describe('localSupabaseOrigin（scripts/serve.mjs 的 CSP 放行）', () => {
  it('只有本机栈才返回源', () => {
    expect(localSupabaseOrigin(env(LOCAL))).toBe('http://127.0.0.1:54321');
    expect(localSupabaseOrigin(env(TEST))).toBeNull();
    expect(localSupabaseOrigin(env(PROD))).toBeNull();
    expect(localSupabaseOrigin({})).toBeNull();
    expect(localSupabaseOrigin({ PUBLIC_SUPABASE_URL: 'http://10.0.0.5:1' })).toBeNull();
  });
});

describe('服务端运行时：serverSupabaseConfig + 503（每次请求都按 process.env 重新判定）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('Preview 缺变量 → SupabaseConfigError → 503 service_not_configured', async () => {
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

  // 真实路由模块 + 真实 process.env：解析失败时路由返回 503，且一个请求都不发（fetch 只被观察，不被替换）
  it.each([
    [
      'Preview 缺变量',
      { VERCEL: '1', VERCEL_ENV: 'preview', PUBLIC_SUPABASE_URL: '', PUBLIC_SUPABASE_KEY: '' },
    ],
    ['Preview 指向生产', { VERCEL: '1', VERCEL_ENV: 'preview', ...env(PROD) }],
    ['本机 / CI 指向生产', { VERCEL: '', VERCEL_ENV: '', ...env(PROD) }],
    ['生产部署指向测试项目', { VERCEL: '1', VERCEL_ENV: 'production', ...env(TEST) }],
    [
      '清单外项目',
      {
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        PUBLIC_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
        PUBLIC_SUPABASE_KEY: 'k',
      },
    ],
  ])('/api/subscribe：%s → 503，不发任何请求', async (_l, e) => {
    for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v);
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

  it('Preview 配了测试项目 → 用测试项目', () => {
    expect(serverSupabaseConfig({ VERCEL: '1', VERCEL_ENV: 'preview', ...env(TEST) })).toEqual(TEST);
  });
});

describe('浏览器端 supabaseConfig（构建期部署类别 + 同一允许清单再校验）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('读构建期 PUBLIC_* 变量（测试项目 / 本机栈）', () => {
    vi.stubEnv('PUBLIC_SUPABASE_URL', TEST.url);
    vi.stubEnv('PUBLIC_SUPABASE_KEY', TEST.key);
    expect(supabaseConfig()).toEqual(TEST);
    vi.stubEnv('PUBLIC_SUPABASE_URL', LOCAL.url);
    expect(supabaseConfig().url).toBe(LOCAL.url);
  });

  it('非生产构建的包里被塞进生产地址 → 报错', () => {
    vi.stubEnv('PUBLIC_SUPABASE_URL', PROD.url);
    vi.stubEnv('PUBLIC_SUPABASE_KEY', PROD.key);
    expect(import.meta.env.PUBLIC_SUPABASE_PROD_REF).toBe('');
    expect(() => supabaseConfig()).toThrow(SupabaseConfigError);
  });

  it('只配了一个 → 报错', () => {
    vi.stubEnv('PUBLIC_SUPABASE_URL', TEST.url);
    vi.stubEnv('PUBLIC_SUPABASE_KEY', '');
    expect(() => supabaseConfig()).toThrow(SupabaseConfigError);
  });
});

describe('源码里没有别处硬编码生产 Supabase', () => {
  it('生产 ref / key 只出现在 scripts/supabase-prod.mjs（不在 src/、不在会被打包的 supabase-env.mjs）', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|js|mjs|astro|svelte)$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (text.includes(PRODUCTION_REF) || text.includes(PRODUCTION_PUBLISHABLE_KEY))
            hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, 'src'));
    for (const f of [
      'astro.config.mjs',
      'playwright.config.ts',
      'vitest.config.ts',
      'scripts/serve.mjs',
      'scripts/supabase-env.mjs',
    ]) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      if (text.includes(PRODUCTION_REF) || text.includes(PRODUCTION_PUBLISHABLE_KEY)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

describe('checkSupabaseConfig（浏览器端用的判定本体）与 resolveSupabaseConfig 同一规则', () => {
  const SECRET = 'sb_secret_abc';
  const cases: Array<[string, Record<string, string>, typeof PI | undefined]> = [];
  for (const [name, extra] of [...NONPROD, ['Vercel production', PRODENV] as const]) {
    for (const c of [TEST, LOCAL, PROD, { url: TEST.url, key: PROD.key }, { url: TEST.url, key: SECRET }]) {
      for (const pi of [PI, undefined])
        cases.push([`${name} ${c.url} ${c.key}`, { ...extra, ...env(c) }, pi]);
    }
    cases.push([`${name} 缺 URL`, { ...extra, PUBLIC_SUPABASE_KEY: TEST.key }, PI]);
    cases.push([`${name} 缺 KEY`, { ...extra, PUBLIC_SUPABASE_URL: TEST.url }, PI]);
    cases.push([
      `${name} 不在清单`,
      { ...extra, ...env({ url: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', key: TEST.key }) },
      PI,
    ]);
  }
  it.each(cases)('%s', (_n, e, pi) => {
    const r = checkSupabaseConfig(e, pi);
    let resolved: unknown = null;
    let threw = false;
    try {
      resolved = resolveSupabaseConfig(e, pi);
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseConfigError);
      threw = true;
    }
    expect(r.ok).toBe(!threw);
    if (r.ok) expect(resolved).toEqual({ url: r.url, key: r.key, source: 'env', target: r.target });
  });
});
