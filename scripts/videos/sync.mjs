#!/usr/bin/env node
/**
 * 视频栏目维护脚本（T6.7）：
 *  1. 逐个用 YouTube oEmbed 核对 src/content/videos/*.md：视频仍存在、允许嵌入（oEmbed 对禁止嵌入的视频返回 401），
 *     原标题 / 频道名与档案一致（不一致只报告，不自动改）。
 *  2. 缺少本地缩略图时下载平台缩略图（maxres → sd → hq），裁成 16:9，生成 480 / 960 宽的 AVIF + WebP
 *     到 public/videos/thumbs/<slug>-{480,960}.{avif,webp}。页面只用这些本地文件，不热链平台图片。
 * 用法：node scripts/videos/sync.mjs [--thumbs-only | --check-only] [--force]
 *   --force  重新生成已存在的缩略图
 * 需要联网；CI 不跑（构建与单元测试只检查本地文件是否齐全）。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = new Set(process.argv.slice(2));
const dir = 'src/content/videos';
const dest = 'public/videos/thumbs';
fs.mkdirSync(dest, { recursive: true });

const entries = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const [, fm] = fs.readFileSync(path.join(dir, f), 'utf8').split(/^---$/m);
    return { slug: f.replace(/\.md$/, ''), data: JSON.parse(fm) };
  });

let problems = 0;
for (const { slug, data } of entries) {
  const provider = data.provider ?? 'youtube';
  if (provider !== 'youtube') {
    console.log(`- ${slug}：${provider} 视频请手动核对与准备缩略图`);
    continue;
  }
  const watch = `https://www.youtube.com/watch?v=${data.videoId}`;
  if (!args.has('--thumbs-only')) {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
    if (!r.ok) {
      problems++;
      console.log(`✗ ${slug}：oEmbed ${r.status}（${r.status === 401 ? '禁止嵌入' : '视频不存在或不可用'}）`);
      continue;
    }
    const o = await r.json();
    const diffs = [];
    if (o.title !== data.originalTitle) diffs.push(`标题「${o.title}」`);
    if (o.author_name !== data.channel.name) diffs.push(`频道「${o.author_name}」`);
    if (diffs.length) {
      problems++;
      console.log(`! ${slug}：与档案不一致 —— ${diffs.join('，')}`);
    } else console.log(`✓ ${slug}`);
  }
  if (args.has('--check-only')) continue;
  const have = [480, 960].every((w) =>
    ['avif', 'webp'].every((e) => fs.existsSync(path.join(dest, `${slug}-${w}.${e}`))),
  );
  if (have && !args.has('--force')) continue;
  let buf;
  for (const n of ['maxresdefault', 'sddefault', 'hqdefault']) {
    const r = await fetch(`https://i.ytimg.com/vi/${data.videoId}/${n}.jpg`);
    if (!r.ok) continue;
    const b = Buffer.from(await r.arrayBuffer());
    const m = await sharp(b).metadata();
    // maxresdefault 不存在时有的视频会返回 120 宽的占位图
    if (m.width >= 480) {
      buf = b;
      break;
    }
  }
  if (!buf) {
    problems++;
    console.log(`✗ ${slug}：拿不到缩略图`);
    continue;
  }
  const m = await sharp(buf).metadata();
  const h = Math.min(m.height, Math.round((m.width * 9) / 16));
  const master = await sharp(buf)
    .extract({ left: 0, top: Math.round((m.height - h) / 2), width: m.width, height: h })
    .toBuffer();
  for (const w of [480, 960]) {
    const img = sharp(master).resize(w, Math.round((w * 9) / 16), { fit: 'cover' });
    await img
      .clone()
      .avif({ quality: 52, effort: 6 })
      .toFile(path.join(dest, `${slug}-${w}.avif`));
    await img
      .clone()
      .webp({ quality: 74, effort: 6 })
      .toFile(path.join(dest, `${slug}-${w}.webp`));
  }
  console.log(`  缩略图已生成：${slug}`);
}
console.log(problems ? `\n${problems} 个问题需要处理` : '\n全部正常');
process.exit(problems ? 1 : 0);
