/**
 * 视频栏目（/videos/）：分类、筛选查询串、时长换算、嵌入地址。
 * 纯函数，页面（构建期）、筛选 island（浏览器）与单元测试共用。
 *
 * 原则：只收录可公开嵌入的视频，播放器在访客点击后才从视频平台加载（facade），
 * 本站只存缩略图与原创导读，不下载、不转载视频本身。
 */

/** 分类（/videos/ 的标签页）。一个视频可属于多个分类，第一个是主分类 */
export const VIDEO_CATEGORIES = {
  'ai-coding': 'AI 编程',
  gamedev: '游戏开发',
  indie: '独立游戏',
  tutorial: '教程',
} as const;
export type VideoCategory = keyof typeof VIDEO_CATEGORIES;
export const VIDEO_CATEGORY_IDS = Object.keys(VIDEO_CATEGORIES) as VideoCategory[];
export const VIDEO_CATEGORY_LEDE: Record<VideoCategory, string> = {
  'ai-coding': 'AI 编程工具与智能体的官方演示、发布会与设计访谈。',
  gamedev: 'Godot、Unity、Unreal、Blender 的技术分享与工作流讲解。',
  indie: '独立游戏的发布预告、年度展示与设计心得。',
  tutorial: '从零上手的入门教程与最佳实践讲座。',
};

/** 视频平台。新增平台时同时改 embedUrl()、watchUrl() 与 vercel.json 的 frame-src（scripts/check-csp.mjs 会核对） */
export const VIDEO_PROVIDERS = ['youtube', 'bilibili'] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];
export const PROVIDER_LABEL: Record<VideoProvider, string> = { youtube: 'YouTube', bilibili: '哔哩哔哩' };
/** 每个平台的嵌入域名（CSP frame-src 白名单只放实际用到的平台） */
export const PROVIDER_FRAME_ORIGIN: Record<VideoProvider, string> = {
  youtube: 'https://www.youtube-nocookie.com',
  bilibili: 'https://player.bilibili.com',
};
export const VIDEO_ID_RE: Record<VideoProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  bilibili: /^BV[0-9A-Za-z]{10}$/,
};

/** 播放器地址（点击后才写进 iframe）。YouTube 用 youtube-nocookie.com 的隐私增强模式 */
export function embedUrl(provider: VideoProvider, id: string, start = 0): string {
  const t = Math.max(0, Math.floor(start));
  if (provider === 'bilibili') {
    const q = new URLSearchParams({ bvid: id, autoplay: '1', high_quality: '1', danmaku: '0' });
    if (t) q.set('t', String(t));
    return `${PROVIDER_FRAME_ORIGIN.bilibili}/player.html?${q}`;
  }
  const q = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1' });
  if (t) q.set('start', String(t));
  return `${PROVIDER_FRAME_ORIGIN.youtube}/embed/${encodeURIComponent(id)}?${q}`;
}

/** 在原平台观看的地址（无 JS 时 facade 本身就是这个链接） */
export function watchUrl(provider: VideoProvider, id: string, start = 0): string {
  const t = Math.max(0, Math.floor(start));
  if (provider === 'bilibili') return `https://www.bilibili.com/video/${id}/${t ? `?t=${t}` : ''}`;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t ? `&t=${t}s` : ''}`;
}

/** "1:02:03" / "12:04" / "0:42" → 秒；格式不对返回 null */
export function parseClock(s: string): number | null {
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 秒 → ISO 8601 时长（schema.org VideoObject.duration），如 PT12M4S */
export function isoDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

/** 秒 → 「12 分钟」「1 小时 6 分」（给读屏与卡片说明用） */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${m} 分钟`;
}

/** 时长档位（筛选用）：短 < 10 分钟，中 10–30 分钟，长 > 30 分钟；时长未核实的视频不属于任何档位 */
export const LENGTHS = ['short', 'medium', 'long'] as const;
export type VideoLength = (typeof LENGTHS)[number];
export const LENGTH_LABEL: Record<VideoLength, string> = {
  short: '10 分钟内',
  medium: '10–30 分钟',
  long: '30 分钟以上',
};
export function lengthOf(seconds: number | null | undefined): VideoLength | '' {
  if (seconds == null) return '';
  if (seconds < 600) return 'short';
  if (seconds <= 1800) return 'medium';
  return 'long';
}

/** 频道名 → 查询串里用的短标识（小写字母数字与 -） */
export const channelKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';

export interface VideoQuery {
  len: VideoLength | '';
  ch: string;
}

const isIn = <T extends string>(list: readonly T[], v: string | null): v is T =>
  v != null && (list as readonly string[]).includes(v);

/** 解析 /videos/ 的查询串（?len=short&ch=godot-engine），非法值忽略；ch 是否存在由页面自己判断 */
export function parseVideoQuery(search: string | URLSearchParams): VideoQuery {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const len = q.get('len');
  const ch = q.get('ch') ?? '';
  return { len: isIn(LENGTHS, len) ? len : '', ch: /^[a-z0-9-]{1,40}$/.test(ch) ? ch : '' };
}

export function videoQueryString(q: Partial<VideoQuery>): string {
  const p = new URLSearchParams();
  if (q.len) p.set('len', q.len);
  if (q.ch) p.set('ch', q.ch);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function filterVideos<T extends { length: VideoLength | ''; channel: string }>(
  items: T[],
  q: Partial<VideoQuery>,
): T[] {
  return items.filter((v) => (!q.len || v.length === q.len) && (!q.ch || v.channel === q.ch));
}

/** 卡片 / 详情页的缩略图（本地 AVIF + WebP，构建前由 scripts/videos/thumbs.mjs 生成） */
export const THUMB_WIDTHS = [480, 720, 960] as const;
export const thumbPath = (slug: string, w: (typeof THUMB_WIDTHS)[number], ext: 'avif' | 'webp') =>
  `/videos/thumbs/${slug}-${w}.${ext}`;
export const thumbSrcset = (slug: string, ext: 'avif' | 'webp') =>
  THUMB_WIDTHS.map((w) => `${thumbPath(slug, w, ext)} ${w}w`).join(', ');
/** <img sizes>（预加载的 imagesizes 必须与之一致，否则会重复下载） */
export const CARD_SIZES = '(min-width: 1100px) 340px, (min-width: 700px) 45vw, 92vw';
/** 播放器 / 详情缩略图：手机两侧减去 --gutter 16px，412 × 1.75 取 720w 而不是 960w（Lighthouse /en/videos/ LCP） */
export const PLAYER_SIZES = '(min-width: 1000px) 920px, (min-width: 600px) 100vw, calc(100vw - 32px)';

/** 发布时间（ISO，带时区）→ 北京时间的 YYYY-MM-DD（页面显示用） */
export function publishedDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** /videos/ 卡片与客户端筛选用的条目 */
export interface VideoItem {
  slug: string;
  title: string;
  originalTitle: string;
  summary: string;
  provider: VideoProvider;
  channel: string;
  channelName: string;
  categories: VideoCategory[];
  seconds: number | null;
  duration: string;
  length: VideoLength | '';
  published: string;
  owner: boolean;
  order: number;
  url: string;
}
