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

describe('astro.config.mjs 构建期检查', () => {
  it('Vercel Preview 缺变量 → 构建失败，错误写明原因', () => {
    const r = loadConfig({ VERCEL: '1', VERCEL_ENV: 'preview' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SupabaseConfigError/);
    expect(r.stderr).toMatch(/非生产部署不会回退到生产 Supabase/);
  });

  it('Vercel Development 缺变量 → 构建失败', () => {
    expect(loadConfig({ VERCEL: '1', VERCEL_ENV: 'development' }).status).not.toBe(0);
  });

  it('只配了 URL → 构建失败', () => {
    const r = loadConfig({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      PUBLIC_SUPABASE_URL: 'https://ovvtestprojectref.supabase.co',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/必须同时设置/);
  });

  it('Vercel Preview 配了测试项目 → 正常', () => {
    const r = loadConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      PUBLIC_SUPABASE_URL: 'https://ovvtestprojectref.supabase.co',
      PUBLIC_SUPABASE_KEY: 'sb_publishable_test',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('Vercel Production 缺变量 → 正常，但打印警告（受保护的生产默认值）', () => {
    const r = loadConfig({ VERCEL: '1', VERCEL_ENV: 'production' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/受保护的生产默认值/);
  });

  it('本机 / CI（不在 Vercel）→ 正常', () => {
    expect(loadConfig({}).status).toBe(0);
  });
});
