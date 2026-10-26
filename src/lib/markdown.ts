/**
 * 轻量 Markdown → 安全 HTML（论坛主题、回复、评论共用）。
 *
 * 安全模型（两道防线）：
 *  1. 本渲染器「先转义、后标记」：输入里的 < > & " ' 一律先转成实体，任何原始 HTML 都只会显示为文字；
 *     渲染器自己只产出白名单里的标签（见 ALLOWED_TAGS），链接只允许 http(s) / mailto / 站内相对路径。
 *  2. 浏览器端再经 DOMPurify（src/lib/sanitize.ts）按同一份白名单过一遍。
 *
 * 支持：段落与换行、**粗体**、*斜体*、~~删除线~~、`行内代码`、``` 代码块 ```、> 引用、
 * - / 1. 列表、# 标题（映射为 h3–h5，页面大纲里 h1/h2 属于页面本身）、--- 分隔线、
 * [文字](链接)、裸链接自动识别、![说明](图片地址)（只显示本站图片桶里的图，见 src/lib/images.ts）。不支持原始 HTML。
 */
/* eslint-disable no-control-regex -- 行内占位符用 \u0000（输入里先剔除），安全 URL 判断要去掉控制字符 */
import { escapeHtml } from './escape';
import { parseImageUrl } from './images';

export const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h3',
  'h4',
  'h5',
  'hr',
  'a',
  'img',
] as const;
export const ALLOWED_ATTR = [
  'href',
  'rel',
  'start',
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'decoding',
] as const;
export const LINK_REL = 'nofollow ugc noopener';

/** 允许的链接：http(s)、mailto、站内绝对路径（/…，不含 //）与页内锚点 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.length > 2000) return null;
  // 去掉控制字符与空白后再判断协议（防 java\tscript: 之类）
  const probe = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
  if (/^https?:\/\/[^\s/]/.test(probe)) return url;
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(probe)) return url;
  if (/^\/(?!\/)/.test(probe) || /^#[\w-]*$/.test(probe)) return url;
  return null;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

function link(text: string, hrefEscaped: string): string {
  const href = safeUrl(unescape(hrefEscaped));
  if (!href) return text;
  return `<a href="${escapeHtml(href)}" rel="${LINK_REL}">${text}</a>`;
}

/** ![说明](地址)：不在白名单里的地址退化为普通链接（或纯文字） */
function image(altEscaped: string, srcEscaped: string): string {
  const img = parseImageUrl(unescape(srcEscaped));
  if (!img) return link(altEscaped || escapeHtml('图片'), srcEscaped);
  const size = img.width && img.height ? ` width="${img.width}" height="${img.height}"` : '';
  return `<img src="${escapeHtml(img.url)}" alt="${altEscaped}"${size} loading="lazy" decoding="async">`;
}

/** 行内标记。输入是「已转义」的文本。 */
export function inline(escaped: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = escaped;
  // 行内代码最先处理：里面的内容不再解析
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${c}</code>`));
  // ![说明](图片)——要在链接之前，否则会被当成「!」+ 链接
  s = s.replace(/!\[([^\]\n]{0,300})\]\(([^)\s]{1,2000})\)/g, (_, a: string, u: string) => hold(image(a, u)));
  // [文字](链接)
  s = s.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g, (_, t: string, h: string) => hold(link(t, h)));
  // 裸链接
  s = s.replace(/\bhttps?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<>"'\u0000])+/g, (m: string) => {
    const trail = /[.,;:!?。，；：！？）)]+$/.exec(m)?.[0] ?? '';
    const u = trail ? m.slice(0, -trail.length) : m;
    return hold(link(u, u)) + trail;
  });
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([^_\n]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  // 占位符还原（可能嵌套：链接文字里的代码）
  for (let i = 0; i < 3 && s.includes('\u0000'); i++)
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[Number(n)] ?? '');
  return s;
}

const RE = {
  fence: /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/,
  heading: /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?(.*)$/,
  ul: /^\s{0,3}[-*+]\s+(.*)$/,
  ol: /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/,
  blank: /^\s*$/,
};
const isBlockStart = (l: string) =>
  RE.fence.test(l) ||
  RE.heading.test(l) ||
  RE.hr.test(l) ||
  RE.quote.test(l) ||
  RE.ul.test(l) ||
  RE.ol.test(l);

function blocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    const fence = RE.fence.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i]))
        body.push(lines[i++]);
      i++; // 结束栅栏（没有也照样结束）
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = RE.heading.exec(line);
    if (h) {
      const level = h[1].length + 2;
      out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && RE.quote.test(lines[i])) inner.push(RE.quote.exec(lines[i++])![1]);
      out.push(
        depth < 3
          ? `<blockquote>${blocks(inner, depth + 1)}</blockquote>`
          : `<blockquote><p>${inline(escapeHtml(inner.join(' ')))}</p></blockquote>`,
      );
      continue;
    }
    const ordered = RE.ol.exec(line);
    if (ordered || RE.ul.test(line)) {
      const re = ordered ? RE.ol : RE.ul;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        const m = re.exec(lines[i++])!;
        let text = ordered ? m[2] : m[1];
        // 缩进的续行并入当前项
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !isBlockStart(lines[i]))
          text += '\n' + lines[i++].trim();
        items.push(`<li>${inline(escapeHtml(text)).replace(/\n/g, '<br>')}</li>`);
      }
      const start = ordered && Number(ordered[1]) !== 1 ? ` start="${Number(ordered[1])}"` : '';
      out.push(ordered ? `<ol${start}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !RE.blank.test(lines[i]) && !(para.length && isBlockStart(lines[i])))
      para.push(lines[i++]);
    out.push(`<p>${para.map((l) => inline(escapeHtml(l.trim()))).join('<br>')}</p>`);
  }
  return out.join('');
}

/** Markdown → HTML（已转义、仅白名单标签）。浏览器端展示前再经 sanitize()。 */
export function renderMarkdown(src: string): string {
  const text = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
  return blocks(text.split('\n'), 0);
}

/** 纯文本摘要（通知、搜索结果）：去掉 Markdown 标记 */
export function markdownToText(src: string, max = 140): string {
  const t = String(src ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
