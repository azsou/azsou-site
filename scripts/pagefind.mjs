#!/usr/bin/env node
/**
 * 构建后生成 Pagefind 全文索引（T7.1）：dist/client/pagefind/。
 *  - 只索引带 data-pagefind-body 的页面：应用、AI 工具、视频、游戏、文章、作品、论坛种子主题（Base.astro 的 searchType）。
 *  - <html lang="zh-CN"> → Pagefind extended 做中文分词（npm 包自带 extended 二进制）；/en/ 页面（lang="en"）单独一套英文索引，
 *    Pagefind 按页面的 lang 自动选用。
 *  - 删掉用不到的官方 UI 文件（我们用自己的面板），并检查体积预算：打开面板时要下载的
 *    pagefind.js + worker + wasm + 元数据（gzip）≤ 120 KB。
 *  - Vercel 适配器在 astro build 结束时已把 dist/client 复制到 .vercel/output/static，这里把索引也复制过去，
 *    否则线上没有 /pagefind/。
 * 用法：node scripts/pagefind.mjs [dist/client]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as pagefind from 'pagefind';

const site = process.argv[2] || 'dist/client';
const out = path.join(site, 'pagefind');
const BUDGET = 120 * 1024;

const { index, errors } = await pagefind.createIndex({});
if (!index) throw new Error(`Pagefind 初始化失败：${errors.join('; ')}`);
const added = await index.addDirectory({ path: site });
if (added.errors.length) throw new Error(`Pagefind 索引失败：${added.errors.join('; ')}`);
fs.rmSync(out, { recursive: true, force: true });
const written = await index.writeFiles({ outputPath: out });
if (written.errors.length) throw new Error(`Pagefind 写入失败：${written.errors.join('; ')}`);
await pagefind.close();

for (const f of fs.readdirSync(out))
  if (/^pagefind-(component-ui|modular-ui|ui|highlight)\.(js|css)$/.test(f)) fs.rmSync(path.join(out, f));

const vercelStatic = '.vercel/output/static';
if (site === 'dist/client' && fs.existsSync(vercelStatic)) {
  fs.rmSync(path.join(vercelStatic, 'pagefind'), { recursive: true, force: true });
  fs.cpSync(out, path.join(vercelStatic, 'pagefind'), { recursive: true });
}

const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(out, f))).length;
const files = fs.readdirSync(out).filter((f) => fs.statSync(path.join(out, f)).isFile());
// wasm 与索引分片本身已压缩（Pagefind 用 gzip 写入），按原大小计
const raw = (f) => fs.statSync(path.join(out, f)).size;
// 每种语言一套索引（T7.6：<html lang> = zh-CN / en）：页面只下载自己语言的元数据与 WASM，预算按语言分别计
const entry = JSON.parse(fs.readFileSync(path.join(out, 'pagefind-entry.json'), 'utf8'));
const shared = files.filter((f) => /\.(js|json)$/.test(f)).reduce((n, f) => n + gz(f), 0);
const perLang = Object.entries(entry.languages).map(([lang, l]) => {
  const meta = `pagefind.${l.hash}.pf_meta`;
  const wasm = `wasm.${l.wasm ?? 'unknown'}.pagefind`;
  return { lang, pages: l.page_count, boot: shared + raw(meta) + (files.includes(wasm) ? raw(wasm) : 0) };
});
const pages = fs.readdirSync(path.join(out, 'fragment')).length;
for (const l of perLang)
  console.log(
    `Pagefind [${l.lang}]：${l.pages} 个页面；首次打开搜索需下载 ${(l.boot / 1024).toFixed(1)} KB（预算 ${BUDGET / 1024} KB）`,
  );
if (pages < 50 || !perLang.some((l) => l.lang.startsWith('zh')) || !perLang.some((l) => l.lang === 'en')) {
  console.error(
    '✗ 索引页面太少或缺少语言：detail 页面应带 data-pagefind-body（Base.astro searchType），中英文各一套索引',
  );
  process.exit(1);
}
if (perLang.some((l) => l.boot > BUDGET)) {
  console.error('✗ Pagefind 启动体积超出预算');
  process.exit(1);
}
