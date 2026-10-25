/**
 * T6.7 视频栏目：纯函数（时长换算、嵌入地址、查询串、筛选）+ 内容完整性
 * （缩略图在本地、只收录核实过的字段、不含播放量、引用不悬空、CSP 与平台一致）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  VIDEO_CATEGORY_IDS,
  VIDEO_ID_RE,
  channelKey,
  embedUrl,
  filterVideos,
  humanDuration,
  isoDuration,
  lengthOf,
  parseClock,
  parseVideoQuery,
  publishedDate,
  thumbSrcset,
  videoQueryString,
  watchUrl,
} from '@/lib/videos';

const root = path.resolve(__dirname, '../..');
type Entry = { data: Record<string, any>; body: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (dir: string): Record<string, Entry> =>
  Object.fromEntries(
    fs
      .readdirSync(path.join(root, 'src/content', dir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const text = fs.readFileSync(path.join(root, 'src/content', dir, f), 'utf8');
        const [, fm, ...body] = text.split(/^---$/m);
        return [f.replace(/\.md$/, ''), { data: JSON.parse(fm), body: body.join('---').trim() }];
      }),
  );
const videos = read('videos');
const tools = read('tools');
const apps = read('apps');

describe('视频：纯函数', () => {
  it('parseClock / isoDuration / humanDuration', () => {
    expect(parseClock('0:42')).toBe(42);
    expect(parseClock('12:04')).toBe(724);
    expect(parseClock('2:46:36')).toBe(9996);
    for (const bad of ['', '12', '1:2', '1:60', 'a:bc', '12:04:']) expect(parseClock(bad), bad).toBeNull();
    expect(isoDuration(724)).toBe('PT12M4S');
    expect(isoDuration(9996)).toBe('PT2H46M36S');
    expect(isoDuration(3600)).toBe('PT1H');
    expect(isoDuration(0)).toBe('PT0S');
    expect(humanDuration(42)).toBe('42 秒');
    expect(humanDuration(724)).toBe('12 分钟');
    expect(humanDuration(9996)).toBe('2 小时 47 分');
  });
  it('lengthOf：10 分钟 / 30 分钟为界，时长未知不属于任何档位', () => {
    expect(lengthOf(599)).toBe('short');
    expect(lengthOf(600)).toBe('medium');
    expect(lengthOf(1800)).toBe('medium');
    expect(lengthOf(1801)).toBe('long');
    expect(lengthOf(null)).toBe('');
  });
  it('embedUrl：YouTube 用 youtube-nocookie.com，自动播放、起始时间；哔哩哔哩用 player.bilibili.com', () => {
    expect(embedUrl('youtube', 'vLIDHi-1PVU')).toBe(
      'https://www.youtube-nocookie.com/embed/vLIDHi-1PVU?autoplay=1&rel=0&playsinline=1',
    );
    expect(embedUrl('youtube', 'vLIDHi-1PVU', 80.7)).toContain('&start=80');
    expect(new URL(embedUrl('bilibili', 'BV1xx411c7mD', 30)).host).toBe('player.bilibili.com');
    expect(embedUrl('bilibili', 'BV1xx411c7mD', 30)).toContain('bvid=BV1xx411c7mD');
    expect(embedUrl('bilibili', 'BV1xx411c7mD', 30)).toContain('t=30');
    expect(watchUrl('youtube', 'vLIDHi-1PVU', 100)).toBe(
      'https://www.youtube.com/watch?v=vLIDHi-1PVU&t=100s',
    );
    expect(watchUrl('bilibili', 'BV1xx411c7mD')).toBe('https://www.bilibili.com/video/BV1xx411c7mD/');
  });
  it('查询串：解析忽略非法值，生成与解析互逆', () => {
    expect(parseVideoQuery('?len=short&ch=godot-engine')).toEqual({ len: 'short', ch: 'godot-engine' });
    expect(parseVideoQuery('?len=huge&ch=<x>')).toEqual({ len: '', ch: '' });
    expect(videoQueryString({ len: 'long', ch: 'unity' })).toBe('?len=long&ch=unity');
    expect(videoQueryString({ len: '', ch: '' })).toBe('');
    const q = { len: 'medium', ch: 'unreal-engine' } as const;
    expect(parseVideoQuery(videoQueryString(q))).toEqual(q);
  });
  it('filterVideos 与 channelKey', () => {
    const items = [
      { id: 1, length: 'short', channel: 'unity' },
      { id: 2, length: 'long', channel: 'unity' },
      { id: 3, length: 'long', channel: 'godot-engine' },
      { id: 4, length: '', channel: 'godot-engine' },
    ] as const;
    expect(filterVideos([...items], {}).map((v) => v.id)).toEqual([1, 2, 3, 4]);
    expect(filterVideos([...items], { len: 'long' }).map((v) => v.id)).toEqual([2, 3]);
    expect(filterVideos([...items], { len: 'long', ch: 'unity' }).map((v) => v.id)).toEqual([2]);
    expect(channelKey('Google for Developers')).toBe('google-for-developers');
    expect(channelKey('Unreal Engine')).toBe('unreal-engine');
  });
  it('publishedDate：按北京时间取日期', () => {
    expect(publishedDate('2025-09-26T19:48:00+00:00')).toBe('2025-09-27');
    expect(publishedDate('2026-10-08T15:59:00+00:00')).toBe('2026-10-08');
  });
});

describe('视频：内容完整性', () => {
  const list = Object.entries(videos);
  it('24 个精选视频，四个分类都有内容，slug 不与应用 / 工具冲突', () => {
    expect(list).toHaveLength(24);
    for (const c of VIDEO_CATEGORY_IDS)
      expect(list.filter(([, v]) => v.data.categories[0] === c).length, c).toBeGreaterThanOrEqual(4);
    for (const slug of Object.keys(videos)) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(['category', 'page'].includes(slug), slug).toBe(false);
    }
  });
  it('视频 ID 合法且不重复；频道是 https 地址；原标题非空', () => {
    const ids = list.map(([, v]) => `${v.data.provider ?? 'youtube'}:${v.data.videoId}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [slug, v] of list) {
      const p = (v.data.provider ?? 'youtube') as keyof typeof VIDEO_ID_RE;
      expect(v.data.videoId, slug).toMatch(VIDEO_ID_RE[p]);
      expect(v.data.channel.url, slug).toMatch(/^https:\/\/www\.youtube\.com\/@/);
      expect(v.data.originalTitle.length, slug).toBeGreaterThan(3);
    }
  });
  it('导读原创：摘要 80–150 字，正文至少两段 + 要点列表', () => {
    for (const [slug, v] of list) {
      expect(v.data.summary.length, slug).toBeGreaterThanOrEqual(80);
      expect(v.data.summary.length, slug).toBeLessThanOrEqual(150);
      expect((v.body.match(/<p>/g) ?? []).length, slug).toBeGreaterThanOrEqual(2);
      expect(v.body, slug).toMatch(/<ul>(<li>[^<]+.*?<\/li>){2,}<\/ul>/s);
      // 不照抄英文原标题当摘要
      expect(v.data.summary, slug).not.toContain(v.data.originalTitle);
    }
  });
  it('缩略图都在本地（480 / 960 × AVIF / WebP），页面不热链平台图片', () => {
    for (const slug of Object.keys(videos))
      for (const ext of ['avif', 'webp'] as const)
        for (const part of thumbSrcset(slug, ext).split(', ')) {
          const file = part.split(' ')[0];
          const p = path.join(root, 'public', file);
          expect(fs.existsSync(p), file).toBe(true);
          expect(fs.statSync(p).size, file).toBeLessThan(150_000);
        }
    expect(JSON.stringify(videos)).not.toMatch(/i\.ytimg\.com|img\.youtube\.com|hdslb\.com/);
  });
  it('只写核实过的字段：时长 / 发布时间格式正确，章节递增且在时长之内；没有播放量', () => {
    for (const [slug, v] of list) {
      const d = v.data;
      if (d.duration) expect(parseClock(d.duration), slug).not.toBeNull();
      if (d.published) expect(Number.isNaN(Date.parse(d.published)), slug).toBe(false);
      const ts = (d.chapters ?? []).map((c: { t: string }) => parseClock(c.t)!);
      for (let i = 1; i < ts.length; i++) expect(ts[i], `${slug} 章节 ${i}`).toBeGreaterThan(ts[i - 1]);
      if (ts.length && d.duration) expect(ts.at(-1)!, slug).toBeLessThan(parseClock(d.duration)!);
      expect(d.lastChecked, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const blob = JSON.stringify(videos);
    for (const k of ['views', 'viewCount', 'likes', 'interactionCount', 'rating'])
      expect(blob).not.toContain(`"${k}"`);
  });
  it('相关工具 / 应用都存在', () => {
    for (const [slug, v] of list) {
      for (const t of v.data.relatedTools ?? []) expect(tools[t], `${slug} → /ai/${t}/`).toBeTruthy();
      for (const a of v.data.relatedApps ?? []) expect(apps[a], `${slug} → /apps/${a}/`).toBeTruthy();
    }
  });
  it('站长本人的视频：仓库与 V72 数据里没有找到，「我的视频」区为空（不编造）', () => {
    expect(list.filter(([, v]) => v.data.owner)).toHaveLength(0);
  });
  it('CSP frame-src 只放实际用到的视频平台嵌入域名', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const csp: string = vercel.headers
      .find((h: { source: string }) => h.source === '/((?!_astro/|pagefind/).*)')
      .headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
    const frame = /frame-src ([^;]*)/.exec(csp)![1].split(/\s+/);
    const providers = new Set(list.map(([, v]) => v.data.provider ?? 'youtube'));
    expect(frame.includes('https://www.youtube-nocookie.com')).toBe(providers.has('youtube'));
    expect(frame.includes('https://player.bilibili.com')).toBe(providers.has('bilibili'));
    expect(frame).not.toContain('https://www.youtube.com');
  });
});
