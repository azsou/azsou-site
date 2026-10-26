/**
 * 编辑器图片：浏览器端缩放 / 压缩 → 上传到 Storage（经 DataRepository.media）。
 *  - 最长边缩到 1600px，优先编码为 WebP（质量 0.82）；浏览器不支持 WebP 编码（旧 Safari）时用 JPEG。
 *  - 压完仍超过 2 MB：逐步降低质量与尺寸再试。
 *  - GIF 不超过 2 MB 且尺寸不超限时原样上传（保留动图）；否则转成静态 WebP。
 *  - 原图已经比压缩结果小、格式受支持且不需要缩放时，直接用原图。
 */
import { getRepository, ValidationError } from '@/lib/data';
import {
  checkImageFile,
  EXT_BY_TYPE,
  fitWithin,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  type ImageExt,
} from '@/lib/images';

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  ext: ImageExt;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* 某些浏览器对部分格式不支持 createImageBitmap：退回 <img> */
    }
  }
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } catch {
    throw new ValidationError('无法读取这张图片，文件可能已损坏');
  } finally {
    URL.revokeObjectURL(src);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(d: Decoded, edge: number, quality: number): Promise<PreparedImage> {
  const { width, height } = fitWithin(d.width, d.height, edge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ValidationError('浏览器无法处理图片');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(d.source, 0, 0, width, height);
  let blob = await toBlob(canvas, 'image/webp', quality);
  if (!blob || blob.type !== 'image/webp') {
    // 不支持 WebP 编码：JPEG 没有透明度，先铺白底
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    blob = await toBlob(canvas, 'image/jpeg', quality);
  }
  if (!blob) throw new ValidationError('图片压缩失败');
  return { blob, width, height, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' };
}

/** 选好的文件 → 准备上传的图片 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bad = checkImageFile(file.type, file.size);
  if (bad) throw new ValidationError(bad);
  const d = await decode(file);
  try {
    const fits = Math.max(d.width, d.height) <= MAX_IMAGE_EDGE;
    const original: PreparedImage = {
      blob: file,
      width: d.width,
      height: d.height,
      ext: EXT_BY_TYPE[file.type],
    };
    if (file.type === 'image/gif' && fits && file.size <= MAX_IMAGE_BYTES) return original;
    const steps: [number, number][] = [
      [MAX_IMAGE_EDGE, 0.82],
      [MAX_IMAGE_EDGE, 0.7],
      [1280, 0.7],
      [1024, 0.6],
    ];
    for (const [edge, q] of steps) {
      const out = await encode(d, edge, q);
      if (fits && file.size <= out.blob.size && file.size <= MAX_IMAGE_BYTES) return original;
      if (out.blob.size <= MAX_IMAGE_BYTES) return out;
    }
    throw new ValidationError('图片压缩后仍超过 2 MB，请换一张小一些的图片');
  } finally {
    d.close();
  }
}

export interface ImageUploader {
  upload(file: Blob): Promise<{ url: string }>;
}

/** 默认上传器：压缩 + DataRepository.media；适配器不支持图片时返回 null（编辑器不显示图片按钮） */
export function defaultUploader(): ImageUploader | null {
  const repo = getRepository();
  if (!repo.media) return null;
  return {
    async upload(file) {
      const img = await prepareImage(file);
      return repo.media!.uploadImage(img.blob, img);
    },
  };
}

/** 从剪贴板 / 拖放数据里取出第一张图片 */
export function imageFromTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) return f;
  for (const it of Array.from(dt.items ?? []))
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  return null;
}

export const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes('Files');
