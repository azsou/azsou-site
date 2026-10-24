/**
 * 第二道防线：浏览器端用 DOMPurify 按 Markdown 渲染器的白名单再净化一遍，然后才写入 innerHTML。
 * 只在 island 里动态加载（不进首屏包）。
 */
import DOMPurify from 'dompurify';
import { ALLOWED_ATTR, ALLOWED_TAGS, LINK_REL, renderMarkdown, safeUrl } from './markdown';
import { parseImageUrl } from './images';

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

/** win：测试时传入 jsdom 的 window */
export function getPurifier(win?: Window): Purifier {
  if (purifier && !win) return purifier;
  const p = win ? DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]) : DOMPurify;
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      const href = node.getAttribute('href');
      if (!href || !safeUrl(href)) node.removeAttribute('href');
      node.setAttribute('rel', LINK_REL);
    }
    if (node.nodeName === 'IMG') {
      // 只保留本站图片桶里的图；其余整个移除
      const img = parseImageUrl(node.getAttribute('src') ?? '');
      if (!img) {
        node.remove();
        return;
      }
      node.setAttribute('src', img.url);
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
      if (!node.hasAttribute('alt')) node.setAttribute('alt', '');
      // 宽高只信文件名里的（与渲染器一致），其余一律去掉
      if (img.width && img.height) {
        node.setAttribute('width', String(img.width));
        node.setAttribute('height', String(img.height));
      } else {
        node.removeAttribute('width');
        node.removeAttribute('height');
      }
    }
  });
  if (!win) purifier = p;
  return p;
}

export function sanitize(html: string, win?: Window): string {
  return getPurifier(win).sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/)|#)/i,
    // 非 URI 属性默认也要匹配 ALLOWED_URI_REGEXP；这几个是数字 / 关键字，单独放行
    ADD_URI_SAFE_ATTR: ['width', 'height', 'loading', 'decoding', 'start'],
    RETURN_TRUSTED_TYPE: false,
  }) as string;
}

/** Markdown → 净化后的 HTML，可直接赋给 innerHTML */
export function markdownHtml(src: string, win?: Window): string {
  return sanitize(renderMarkdown(src), win);
}
