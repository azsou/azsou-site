/**
 * 第二道防线：浏览器端用 DOMPurify 按 Markdown 渲染器的白名单再净化一遍，然后才写入 innerHTML。
 * 只在 island 里动态加载（不进首屏包）。
 */
import DOMPurify from 'dompurify';
import { ALLOWED_ATTR, ALLOWED_TAGS, LINK_REL, renderMarkdown, safeUrl } from './markdown';

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
    RETURN_TRUSTED_TYPE: false,
  }) as string;
}

/** Markdown → 净化后的 HTML，可直接赋给 innerHTML */
export function markdownHtml(src: string, win?: Window): string {
  return sanitize(renderMarkdown(src), win);
}
