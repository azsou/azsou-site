#!/usr/bin/env node
// =============================================================================
// Storage 文件本体的备份 / 恢复客户端（站长第三轮：Storage 文件纳入实际恢复范围）。
// 只用 Supabase Storage REST API（storage-api），与托管 Supabase / 自建 storage-api 同一接口：
//   STORAGE_URL          Supabase 项目：https://<ref>.supabase.co/storage/v1；本地 storage-api：http://127.0.0.1:<端口>
//   STORAGE_SERVICE_KEY  service_role key（只从 Secret / 环境变量读，绝不打印、绝不写进任何文件）
//
// 子命令（TSV 均为 UTF-8、制表符分隔、第一行是表头）：
//   download <listing.tsv> <输出目录> <files.tsv> [<etags.tsv>]
//       listing.tsv = 备份快照里 storage.objects 的清单（bucket_id name size mimetype cache_control），
//       etags.tsv  = 同一快照里每个对象的 eTag / lastModified / updated_at / version（db-backup.sh 第五轮起必给）。
//       与数据库各范围同一个导出快照、同一个清单时间。逐个下载到 <输出目录>/<bucket>/<name>，
//       写 files.tsv（bucket name size sha256 content_type cache_control）。
//       任何对象下载失败 / 大小不符 / **同尺寸改写**（响应 ETag 与快照 eTag 不同、内容 md5 与快照 md5 eTag 不同、
//       Last-Modified 晚于快照）→ 非 0 退出，备份失败，不会产出「部分成功」的备份。快照里没有 eTag 的对象无法证明内容一致 → 同样失败。
//   upload <buckets.tsv> <文件目录> <files.tsv>
//       目标项目里按 buckets.tsv 建桶（id name public file_size_limit allowed_mime_types）——桶已存在 → 失败（精确恢复只进空目标）；
//       再按 files.tsv 逐个上传（x-upsert: false，已存在就失败），上传前先核对本地文件 sha256。
//       设了 STORAGE_CREATED_LEDGER 时，把**本次新建**的桶与**本次上传**的对象（含 sha256）逐条记进这个文件，供失败清理用。
//   cleanup <created.tsv>
//       只撤销本次运行创建的东西：逐个对象核对目标上的内容 sha256 仍是本次上传的那份才删除（被别人改过 → 不删、报告）；
//       再删本次新建、且已经空了的桶（还有别的对象 → 不删、报告）。预先存在的桶 / 对象不在清单里，永远不碰。
//   verify <files.tsv> [<buckets.tsv>]
//       从目标逐个下载、比对 sha256 与大小；按桶列出对象（list API 递归）数量必须与清单一致，多一个少一个都失败。
// 退出码：0 成功；1 校验 / 传输失败；2 用法 / 环境错误。
// =============================================================================
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const die = (code, msg) => {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(code);
};
const BASE = (process.env.STORAGE_URL || '').replace(/\/+$/, '');
const KEY = process.env.STORAGE_SERVICE_KEY || '';
if (!BASE || !KEY) die(2, '需要 STORAGE_URL 与 STORAGE_SERVICE_KEY（service_role key，从 Secret 注入）');
const headers = (extra = {}) => ({ authorization: `Bearer ${KEY}`, apikey: KEY, ...extra });
const enc = (name) => name.split('/').map(encodeURIComponent).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const normEtag = (e) =>
  String(e ?? '')
    .trim()
    .replace(/^W\//, '')
    .replace(/^"+|"+$/g, '')
    .toLowerCase();

function readTsv(path) {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length === 0) die(1, `清单为空（缺表头）：${path}`);
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => {
    const cols = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, cols[i] ?? '']));
  });
}
const writeTsv = (path, head, rows) =>
  writeFileSync(
    path,
    [head.join('\t'), ...rows.map((r) => head.map((h) => String(r[h] ?? '')).join('\t'))].join('\n') + '\n',
  );

// 对象名不能逃出目录（../、绝对路径）
function safePath(root, bucket, name) {
  const p = resolve(root, bucket, name);
  if (!p.startsWith(resolve(root) + sep)) die(1, `对象名越界：${bucket}/${name}`);
  return p;
}

async function req(method, path, init = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, { method, ...init });
      // 4xx 不重试（权限 / 不存在 / 已存在都是确定的结果）
      if (r.status < 500) return r;
      last = new Error(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
    } catch (e) {
      last = e;
    }
    await new Promise((s) => setTimeout(s, 500 * (i + 1)));
  }
  throw last;
}

/**
 * 同尺寸改写检测（第五轮 ②）：对象在快照之后被换成**大小相同、内容不同**的文件时，只比大小发现不了。
 * 与快照里的 eTag（md5 形式时直接比内容）、响应 ETag、Last-Modified 比对；任何一项对不上 = 快照之后被改写。
 * 返回 null = 一致；否则返回原因。
 */
export function overwriteReason(snap, resHeaders, buf) {
  if (!snap) return '快照里没有这个对象的 eTag 记录，无法证明下载内容与快照一致';
  const se = normEtag(snap.etag);
  if (!se) return '快照里这个对象没有 eTag，无法证明下载内容与快照一致';
  const he = normEtag(resHeaders.get('etag'));
  if (he && he !== se) return `响应 ETag ${he} ≠ 快照 eTag ${se}`;
  if (/^[0-9a-f]{32}$/.test(se) && md5(buf) !== se) return `内容 md5 ${md5(buf)} ≠ 快照 eTag ${se}`;
  const lm = Date.parse(resHeaders.get('last-modified') ?? '');
  const sm = Date.parse(snap.last_modified || snap.updated_at || '');
  if (Number.isFinite(lm) && Number.isFinite(sm) && lm - sm > 1000)
    return `Last-Modified ${new Date(lm).toISOString()} 晚于快照记录 ${new Date(sm).toISOString()}`;
  return null;
}

async function download(listing, outDir, filesTsv, etagsTsv) {
  const rows = readTsv(listing);
  const snaps = new Map();
  if (etagsTsv) for (const e of readTsv(etagsTsv)) snaps.set(`${e.bucket_id}\u0000${e.name}`, e);
  else die(2, 'download 需要快照 eTag 清单（第 4 个参数）：没有它无法发现快照之后的同尺寸改写');
  const out = [];
  let bytes = 0;
  for (const o of rows) {
    const r = await req('GET', `/object/${encodeURIComponent(o.bucket_id)}/${enc(o.name)}`, {
      headers: headers(),
    });
    if (r.status !== 200)
      die(1, `下载失败 ${o.bucket_id}/${o.name}：HTTP ${r.status}（快照之后被删除或无权限）——备份中止`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (o.size !== '' && Number(o.size) !== buf.length)
      die(
        1,
        `大小与快照元数据不符 ${o.bucket_id}/${o.name}：快照 ${o.size}，下载 ${buf.length}（快照之后被改写）——备份中止`,
      );
    const why = overwriteReason(snaps.get(`${o.bucket_id}\u0000${o.name}`), r.headers, buf);
    if (why) die(1, `内容与快照不一致 ${o.bucket_id}/${o.name}：${why}（快照之后被改写）——备份中止`);
    const p = safePath(outDir, o.bucket_id, o.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    bytes += buf.length;
    out.push({
      bucket: o.bucket_id,
      name: o.name,
      size: buf.length,
      sha256: sha256(buf),
      content_type: o.mimetype || r.headers.get('content-type') || 'application/octet-stream',
      cache_control: o.cache_control || '',
    });
  }
  writeTsv(filesTsv, ['bucket', 'name', 'size', 'sha256', 'content_type', 'cache_control'], out);
  console.log(`storage 文件已下载：${out.length} 个对象 / ${bytes} 字节（逐个与快照 eTag 核对）`);
}

const LEDGER = process.env.STORAGE_CREATED_LEDGER || '';
const record = (...cols) => {
  if (LEDGER) appendFileSync(LEDGER, cols.join('\t') + '\n');
};

async function upload(bucketsTsv, dir, filesTsv) {
  const buckets = readTsv(bucketsTsv);
  for (const b of buckets) {
    const mimes = b.allowed_mime_types ? JSON.parse(b.allowed_mime_types) : null;
    const body = {
      id: b.id,
      name: b.name,
      public: b.public === 't' || b.public === 'true',
      ...(b.file_size_limit ? { file_size_limit: Number(b.file_size_limit) } : {}),
      ...(mimes ? { allowed_mime_types: mimes } : {}),
    };
    const r = await req('POST', '/bucket', {
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (r.status !== 200)
      die(1, `建桶失败 ${b.id}：HTTP ${r.status} ${(await r.text()).slice(0, 200)}（精确恢复只进空目标）`);
    record('bucket', b.id); // 建成功才记：已存在的桶（别人的）不会进清单
  }
  const files = readTsv(filesTsv);
  let bytes = 0;
  for (const f of files) {
    const p = safePath(dir, f.bucket, f.name);
    if (!existsSync(p)) die(1, `归档里缺少文件 ${f.bucket}/${f.name}`);
    const buf = readFileSync(p);
    if (sha256(buf) !== f.sha256) die(1, `归档文件校验和不符 ${f.bucket}/${f.name}`);
    const h = { 'content-type': f.content_type || 'application/octet-stream', 'x-upsert': 'false' };
    if (f.cache_control) h['cache-control'] = f.cache_control;
    const r = await req('POST', `/object/${encodeURIComponent(f.bucket)}/${enc(f.name)}`, {
      headers: headers(h),
      body: buf,
    });
    if (r.status !== 200)
      die(1, `上传失败 ${f.bucket}/${f.name}：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    record('object', f.bucket, f.name, f.sha256);
    bytes += buf.length;
  }
  console.log(`storage 已恢复：${buckets.length} 个桶、${files.length} 个对象 / ${bytes} 字节`);
}

async function listAll(bucket, prefix = '') {
  const names = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await req('POST', `/object/list/${encodeURIComponent(bucket)}`, {
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (r.status !== 200) die(1, `列出对象失败 ${bucket}/${prefix}：HTTP ${r.status}`);
    const items = await r.json();
    for (const it of items) {
      const full = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null || it.id === undefined)
        names.push(...(await listAll(bucket, full))); // 文件夹
      else names.push(full);
    }
    if (items.length < 1000) break;
  }
  return names;
}

async function verify(filesTsv, bucketsTsv) {
  const files = readTsv(filesTsv);
  let bad = 0;
  for (const f of files) {
    const r = await req('GET', `/object/${encodeURIComponent(f.bucket)}/${enc(f.name)}`, {
      headers: headers(),
    });
    if (r.status !== 200) {
      process.stderr.write(`  缺少对象 ${f.bucket}/${f.name}：HTTP ${r.status}\n`);
      bad++;
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== Number(f.size) || sha256(buf) !== f.sha256) {
      process.stderr.write(`  内容不一致 ${f.bucket}/${f.name}\n`);
      bad++;
    }
  }
  const buckets = new Set(files.map((f) => f.bucket));
  if (bucketsTsv) for (const b of readTsv(bucketsTsv)) buckets.add(b.id);
  for (const b of buckets) {
    const want = files
      .filter((f) => f.bucket === b)
      .map((f) => f.name)
      .sort();
    const got = (await listAll(b)).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      process.stderr.write(`  桶 ${b} 对象清单不一致：清单 ${want.length} 个，目标 ${got.length} 个\n`);
      bad++;
    } else console.log(`  桶 ${b}：${got.length} 个对象，sha256 / 大小 / 清单一致`);
  }
  if (bad) die(1, `storage 校验失败：${bad} 处不一致`);
  console.log(`storage 校验通过：${files.length} 个对象`);
}

/** 失败清理：只撤销清单里本次创建 / 上传的东西 */
async function cleanup(createdTsv) {
  const lines = readFileSync(createdTsv, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  let left = 0;
  for (const [kind, bucket, name, sum] of [...lines].reverse()) {
    if (kind !== 'object') continue;
    const r = await req('GET', `/object/${encodeURIComponent(bucket)}/${enc(name)}`, { headers: headers() });
    if (r.status === 404 || r.status === 400) continue; // 已经不在
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || sha256(buf) !== sum) {
      process.stderr.write(
        `  不删 ${bucket}/${name}：目标上的内容已不是本次上传的那份（HTTP ${r.status}）\n`,
      );
      left++;
      continue;
    }
    const d = await req('DELETE', `/object/${encodeURIComponent(bucket)}`, {
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefixes: [name] }),
    });
    if (d.status !== 200) {
      process.stderr.write(`  删除 ${bucket}/${name} 失败：HTTP ${d.status}\n`);
      left++;
    }
  }
  for (const [kind, bucket] of [...lines].reverse()) {
    if (kind !== 'bucket') continue;
    const rest = await listAll(bucket);
    if (rest.length) {
      process.stderr.write(`  不删桶 ${bucket}：里面还有 ${rest.length} 个不是本次上传的对象\n`);
      left++;
      continue;
    }
    const d = await req('DELETE', `/bucket/${encodeURIComponent(bucket)}`, { headers: headers() });
    if (d.status !== 200) {
      process.stderr.write(`  删除桶 ${bucket} 失败：HTTP ${d.status}\n`);
      left++;
    }
  }
  if (left) die(1, `storage 失败清理：${left} 项没有撤销（见上）`);
  console.log('storage 失败清理：本次新建的桶 / 上传的对象已撤销，预先存在的没有动');
}

const [cmd, ...args] = process.argv.slice(2);
const usage = () =>
  die(
    2,
    '用法：storage-files.mjs download <listing.tsv> <目录> <files.tsv> <etags.tsv> | upload <buckets.tsv> <目录> <files.tsv> | verify <files.tsv> [buckets.tsv] | cleanup <created.tsv>',
  );
try {
  if (cmd === 'download' && (args.length === 3 || args.length === 4)) await download(...args);
  else if (cmd === 'cleanup' && args.length === 1) await cleanup(args[0]);
  else if (cmd === 'upload' && args.length === 3) await upload(...args);
  else if (cmd === 'verify' && (args.length === 1 || args.length === 2)) await verify(args[0], args[1]);
  else usage();
} catch (e) {
  die(1, `storage 请求失败：${String(e?.message || e).replace(KEY, '***')}`);
}
