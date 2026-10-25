/**
 * 构建期代码高亮（T9.14，DESIGN-SYSTEM §22.4）：把 <pre><code> 里的源码切成 token，输出
 * <span class="tok-…">，颜色全部由 CSS 类 + token 变量决定（global.css `.prose .tok-*`）。
 * 不用内联 style：站点 CSP 不放行 style-src 'unsafe-inline'，Shiki 默认输出的 style="color:…" 会被拦。
 * 只做通用的「C 系 / Shell」词法：注释、字符串、数字、关键字、函数调用；够文章里的 JS / TS / JSON / CSS / Shell 片段用。
 *
 *  - 语言取 <code class="language-xxx">；没写时按 C 系处理；text / plain / txt 不高亮；
 *  - code 里已有标签（作者手写的 <b> 之类）时原样保留，不高亮。
 */

const KEYWORDS = new Set(
  (
    'as async await break case catch class const continue default delete do else enum export extends false finally for ' +
    'from function if implements import in instanceof interface let new null of private protected public readonly return ' +
    'static super switch this throw true try type typeof undefined var void while yield'
  ).split(' '),
);
const HASH_COMMENT = new Set([
  'sh',
  'bash',
  'shell',
  'zsh',
  'console',
  'yaml',
  'yml',
  'toml',
  'py',
  'python',
  'ini',
]);
const PLAIN = new Set(['text', 'plain', 'txt', 'plaintext']);

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 把纯文本源码切成带类名的 HTML（已转义） */
export function highlightCode(src: string, lang = ''): string {
  const l = lang.toLowerCase();
  if (PLAIN.has(l)) return escape(src);
  const hash = HASH_COMMENT.has(l);
  const re = new RegExp(
    [
      hash ? '(#[^\\n]*)' : '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)', // 1 注释
      '("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)', // 2 字符串
      '(\\b(?:0[xX][\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)', // 3 数字
      '([A-Za-z_$][\\w$]*)(?=\\s*\\()', // 4 函数调用 / 定义
      '([A-Za-z_$][\\w$]*)', // 5 标识符（关键字另判）
    ].join('|'),
    'g',
  );
  let out = '';
  let last = 0;
  for (const m of src.matchAll(re)) {
    const i = m.index ?? 0;
    out += escape(src.slice(last, i));
    last = i + m[0].length;
    const t = escape(m[0]);
    if (m[1]) out += `<span class="tok-c">${t}</span>`;
    else if (m[2]) out += `<span class="tok-s">${t}</span>`;
    else if (m[3]) out += `<span class="tok-n">${t}</span>`;
    else if (m[4])
      out += KEYWORDS.has(m[4]) ? `<span class="tok-k">${t}</span>` : `<span class="tok-f">${t}</span>`;
    else out += KEYWORDS.has(m[0]) ? `<span class="tok-k">${t}</span>` : t;
  }
  return out + escape(src.slice(last));
}

/** 高亮 HTML 里所有 <pre …><code …>…</code></pre> */
export function highlightBlocks(html: string): string {
  return html.replace(
    /(<pre\b[^>]*>\s*<code\b([^>]*)>)([\s\S]*?)(<\/code>\s*<\/pre>)/g,
    (all, open: string, codeAttrs: string, body: string, close: string) => {
      if (/<[a-z]/i.test(body)) return all;
      const lang = /class="[^"]*\blanguage-([\w+-]+)/.exec(codeAttrs)?.[1] ?? '';
      return open + highlightCode(decode(body), lang) + close;
    },
  );
}
