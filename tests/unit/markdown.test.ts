// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { inline, markdownToText, renderMarkdown, safeUrl } from '@/lib/markdown';
import { markdownHtml, sanitize } from '@/lib/sanitize';

const md = (s: string) => markdownHtml(s, window);

describe('renderMarkdown：语法', () => {
  it('段落与换行', () => {
    expect(renderMarkdown('第一行\n第二行\n\n第二段')).toBe('<p>第一行<br>第二行</p><p>第二段</p>');
  });
  it('粗体 / 斜体 / 删除线 / 行内代码', () => {
    expect(renderMarkdown('**粗** *斜* ~~删~~ `a<b>`')).toBe(
      '<p><strong>粗</strong> <em>斜</em> <del>删</del> <code>a&lt;b&gt;</code></p>',
    );
  });
  it('snake_case 与 2*3*4 不被当成强调', () => {
    expect(renderMarkdown('my_var_name 和 2*3*4')).toBe('<p>my_var_name 和 2*3*4</p>');
  });
  it('代码块原样转义，不解析其中的标记', () => {
    expect(renderMarkdown('```js\nconst a = "<b>**x**</b>";\n```')).toBe(
      '<pre><code>const a = &quot;&lt;b&gt;**x**&lt;/b&gt;&quot;;</code></pre>',
    );
  });
  it('未闭合的代码块到文末结束', () => {
    expect(renderMarkdown('```\nabc')).toBe('<pre><code>abc</code></pre>');
  });
  it('标题映射为 h3–h5', () => {
    expect(renderMarkdown('# 一\n## 二\n### 三')).toBe('<h3>一</h3><h4>二</h4><h5>三</h5>');
  });
  it('列表（含续行与起始序号）', () => {
    expect(renderMarkdown('- a\n- b\n  续\n\n3. x\n4. y')).toBe(
      '<ul><li>a</li><li>b<br>续</li></ul><ol start="3"><li>x</li><li>y</li></ol>',
    );
  });
  it('引用可嵌套，深度有上限', () => {
    expect(renderMarkdown('> 外\n> > 内')).toBe(
      '<blockquote><p>外</p><blockquote><p>内</p></blockquote></blockquote>',
    );
    expect(renderMarkdown('> > > > > 深')).toContain('<blockquote>');
  });
  it('分隔线', () => {
    expect(renderMarkdown('a\n\n---\n\nb')).toBe('<p>a</p><hr><p>b</p>');
  });
  it('链接与裸链接（加 rel=nofollow ugc）', () => {
    expect(renderMarkdown('[文档](https://azsou.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://azsou.com/a?b=1&amp;c=2" rel="nofollow ugc noopener">文档</a></p>',
    );
    expect(renderMarkdown('见 https://azsou.com/x。')).toBe(
      '<p>见 <a href="https://azsou.com/x" rel="nofollow ugc noopener">https://azsou.com/x</a>。</p>',
    );
  });
  it('纯文本旧内容（V72 帖子）按段落显示', () => {
    expect(renderMarkdown('你好\n世界')).toBe('<p>你好<br>世界</p>');
  });
});

describe('renderMarkdown：XSS', () => {
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))',
    '[x](//evil.com)',
    '[x](https://a.com" onmouseover="alert(1))',
    '<a href="javascript:alert(1)">x</a>',
    '<svg><script>alert(1)</script></svg>',
    '"><iframe src=//evil.com>',
    '`<img src=x onerror=alert(1)>`',
    '**<b onclick=alert(1)>x</b>**',
    '<style>body{display:none}</style>',
    '&lt;script&gt;',
  ];
  for (const v of vectors) {
    it(`无害：${v}`, () => {
      const html = md(v);
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
      const all = [...doc.body.querySelectorAll('*')];
      expect(
        all
          .map((e) => e.tagName.toLowerCase())
          .filter((t) => !['div', 'p', 'a', 'code', 'strong', 'br'].includes(t)),
      ).toEqual([]);
      for (const e of all) {
        for (const a of [...e.attributes]) {
          expect(a.name).toMatch(/^(href|rel|start)$/);
          if (a.name === 'href') expect(a.value).toMatch(/^(https?:\/\/[^/]|mailto:|\/[^/]|#)/i);
        }
      }
      expect(html).not.toMatch(/<(script|img|iframe|svg|style)|<a[^>]*href="javascript/i);
    });
  }
  it('渲染器本身的输出已安全（DOMPurify 之前）', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });
  it('DOMPurify 剥掉白名单外的标签与属性', () => {
    expect(sanitize('<p onclick="x()">a<img src=x><a href="javascript:1">b</a></p>', window)).toBe(
      '<p>a<a rel="nofollow ugc noopener">b</a></p>',
    );
  });
});

describe('safeUrl / inline / markdownToText', () => {
  it('safeUrl', () => {
    expect(safeUrl('https://a.com')).toBe('https://a.com');
    expect(safeUrl('/forum/')).toBe('/forum/');
    expect(safeUrl('#top')).toBe('#top');
    expect(safeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeUrl('//evil.com')).toBeNull();
    expect(safeUrl(' javascript:alert(1)')).toBeNull();
    expect(safeUrl('ftp://x')).toBeNull();
  });
  it('inline 只接受已转义文本，不会二次转义', () => {
    expect(inline('a &amp; b')).toBe('a &amp; b');
  });
  it('markdownToText 去掉标记并截断', () => {
    expect(markdownToText('**你好** [链接](https://x) `c`\n\n- 项')).toBe('你好 链接 c 项');
    expect(markdownToText('一二三四五', 3)).toBe('一二…');
  });
});
