/**
 * 构建期 fail-closed 检查：astro build 第一步就是加载 astro.config.mjs，这里在子进程里按 Vercel 的环境变量加载它。
 * Vercel 非生产缺 PUBLIC_SUPABASE_URL / KEY → 进程失败并给出明确错误（= 构建失败）；其余情况正常加载。
 * 子进程工作目录是空的临时目录：不读到开发者本机的 .env。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONFIG = pathToFileURL(path.resolve(import.meta.dirname, '../../astro.config.mjs')).href;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'az-build-guard-'));

function loadConfig(env: Record<string, string>) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(VERCEL|PUBLIC_SUPABASE_)/.test(k)),
  ) as Record<string, string>;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(CONFIG)})`],
    {
      cwd,
      env: { ...base, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

const TEST = {
  PUBLIC_SUPABASE_URL: 'https://ovvfwkmqlejcpatmfqcd.supabase.co',
  PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
};
const LOCAL = { PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', PUBLIC_SUPABASE_KEY: 'sb_publishable_local' };
const PROD = {
  PUBLIC_SUPABASE_URL: 'https://abryflgoljltyakthtql.supabase.co',
  PUBLIC_SUPABASE_KEY: 'sb_publishable_whTlV4b20Da6ShYOdYjs0Q_-d6RTSRh',
};

describe('astro.config.mjs 构建期检查（真实配置文件、真实子进程环境）', () => {
  it.each([
    ['Vercel Preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
    ['Vercel Development', { VERCEL: '1', VERCEL_ENV: 'development' }],
    ['Vercel Production', { VERCEL: '1', VERCEL_ENV: 'production' }],
    ['本机 / CI', {}],
  ])('%s 缺变量 → 构建失败（没有默认值）', (_l, e) => {
    const r = loadConfig(e);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SupabaseConfigError/);
    expect(r.stderr).toMatch(/没有默认值/);
  });

  it('只配了 URL → 构建失败', () => {
    const r = loadConfig({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      PUBLIC_SUPABASE_URL: PROD.PUBLIC_SUPABASE_URL,
    });
    expect(r.status).not.toBe(0);
  });

  it.each([
    ['Vercel Preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
    ['本机 / CI', {}],
  ])('%s 指向生产 → 构建失败', (_l, e) => {
    const r = loadConfig({ ...e, ...PROD });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/绝不连生产库/);
  });

  it('Vercel Production 指向测试项目 → 构建失败', () => {
    const r = loadConfig({ VERCEL: '1', VERCEL_ENV: 'production', ...TEST });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/只能连生产项目/);
  });

  it.each([
    ['Vercel Preview + 测试项目', { VERCEL: '1', VERCEL_ENV: 'preview', ...TEST }],
    ['本机 / CI + 本机栈', { ...LOCAL }],
    ['Vercel Production + 显式生产变量', { VERCEL: '1', VERCEL_ENV: 'production', ...PROD }],
  ])('%s → 正常', (_l, e) => {
    const r = loadConfig(e);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
