/**
 * 用户图片（编辑器上传到 Supabase Storage 的 `ugc-images` 公开桶）的纯函数：
 * 限制、尺寸计算、对象路径、公开 URL、渲染时的 URL 白名单、Markdown 片段。
 * 与 db/migrations/0010_ugc_images.sql 的 RLS 规则保持一致（路径 / 扩展名 / 2 MB）。
 */
import { classifySupabaseUrl, supabaseConfig } from './supabase-config';

export const IMAGE_BUCKET = 'ugc-images';
/** 与桶的 file_size_limit 一致 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** 客户端压缩：最长边 */
export const MAX_IMAGE_EDGE = 1600;
/** 选择文件时允许的原始大小（压缩前；更大的直接拒绝，避免手机上解码超大图卡死） */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageExt = 'webp' | 'png' | 'jpg' | 'gif';
export const EXT_BY_TYPE: Record<string, ImageExt> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

/** 选择 / 粘贴 / 拖入的文件是否可以处理；不行时返回中文原因 */
export function checkImageFile(type: string, size: number): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(type)) return '只支持 JPG、PNG、WebP、GIF 图片';
  if (size > MAX_SOURCE_BYTES) return '图片太大（超过 20 MB），请先缩小后再上传';
  if (size <= 0) return '图片文件是空的';
  return null;
}

/** 等比缩放到最长边不超过 max（不放大） */
export function fitWithin(w: number, h: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const k = Math.min(1, max / Math.max(W, H));
  return { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)) };
}

/**
 * 对象路径：`<uid>/<yyyymm>-<随机 12 位>-<宽>x<高>.<ext>`。
 * 宽高写进文件名，渲染时据此输出 width / height，图片加载前就占好位置（不产生布局偏移）。
 */
export function objectPath(
  uid: string,
  img: { width: number; height: number; ext: ImageExt },
  rand: string,
  now = new Date(),
): string {
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const r = rand
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12)
    .padEnd(6, '0');
  return `${uid}/${ym}-${r}-${Math.round(img.width)}x${Math.round(img.height)}.${img.ext}`;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function publicImageUrl(path: string, base = supabaseConfig().url): string {
  return `${trimSlash(base)}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
}

/** 允许出现在帖子里的图片主机：当前 Supabase 项目 + PUBLIC_IMAGE_HOSTS（逗号分隔，换存储时用） */
export function imageHosts(): Set<string> {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(supabaseConfig().url).host);
  } catch {
    /* 配置不是 URL：忽略 */
  }
  const extra = (import.meta.env?.PUBLIC_IMAGE_HOSTS as string | undefined) ?? '';
  for (const h of extra.split(',')) if (h.trim()) hosts.add(h.trim().toLowerCase());
  return hosts;
}

/**
 * 本机栈（E2E / 本地开发，PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 之类）的源：只有这时才接受 http 图片地址。
 * 生产 / 测试项目构建里永远是 null（它们是 https://<ref>.supabase.co）。
 */
function localStackOrigin(): string | null {
  try {
    const { url } = supabaseConfig();
    return classifySupabaseUrl(url)?.target === 'local' ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

const PATH_RE = new RegExp(
  `^/storage/v1/object/public/${IMAGE_BUCKET}/[0-9a-f-]{36}/([a-z0-9][a-z0-9-]{0,79})\\.(webp|png|jpg|jpeg|gif)$`,
);

/**
 * 渲染白名单：只显示本站图片桶里的图（https——本机栈例外、已知主机、规范路径），
 * 防止帖子用外链图片追踪读者或引用不受控的内容。返回 null = 不显示为图片。
 */
export function parseImageUrl(
  raw: string,
  hosts: Set<string> = imageHosts(),
): { url: string; width?: number; height?: number } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const httpLocal = u.protocol === 'http:' && u.origin === localStackOrigin();
  if ((u.protocol !== 'https:' && !httpLocal) || u.username || u.password || u.search || u.hash) return null;
  if (!hosts.has(u.host.toLowerCase())) return null;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return null;
  const dims = /-(\d{1,4})x(\d{1,4})$/.exec(m[1]);
  const out: { url: string; width?: number; height?: number } = { url: u.toString() };
  if (dims && Number(dims[1]) > 0 && Number(dims[2]) > 0) {
    out.width = Number(dims[1]);
    out.height = Number(dims[2]);
  }
  return out;
}

/** 替代文字清洗：单行、去掉会破坏 Markdown 的方括号、最多 120 字 */
export function cleanAlt(alt: string): string {
  return [
    ...alt
      .replace(/[[\]\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 120)
    .join('');
}

export function imageMarkdown(alt: string, url: string): string {
  return `![${cleanAlt(alt) || '图片'}](${url})`;
}

/** 默认的替代文字：文件名去扩展名（「IMG_1234」这类相机文件名不作为说明） */
export function altFromFileName(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (
    !base ||
    /^(img|image|dsc|pxl|screenshot|photo|wechat\w*|mmexport)\s*\d*/i.test(base) ||
    /^\d+$/.test(base)
  )
    return '';
  return cleanAlt(base);
}
