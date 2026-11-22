import { describe, expect, it } from 'vitest';
import { highlightBlocks, highlightCode } from '@/lib/highlight';
import { enhanceProse } from '@/lib/prose';

describe('构建期代码高亮（T9.14）', () => {
  it('注释 / 字符串 / 数字 / 关键字 / 函数调用各自上类名，其余原样转义', () => {
    const h = highlightCode("// hi\nconst a = fn('x<y', 42);");
    expect(h).toContain('<span class="tok-c">// hi</span>');
    expect(h).toContain('<span class="tok-k">const</span>');
    expect(h).toContain('<span class="tok-f">fn</span>');
    expect(h).toContain(`<span class="tok-s">'x&lt;y'</span>`);
    expect(h).toContain('<span class="tok-n">42</span>');
  });
  it('Shell 用 # 注释；text 不高亮', () => {
    expect(highlightCode('npm run build # 构建', 'sh')).toContain('<span class="tok-c"># 构建</span>');
    expect(highlightCode('if (x) # y', 'text')).toBe('if (x) # y');
  });
  it('不写内联 style（严格 CSP）；文本内容不变', () => {
    const src =
      '<pre><code class="language-ts">button.addEventListener(\'click\', () =&gt; {\n  a &amp;&amp; b(1);\n});</code></pre>';
    const out = enhanceProse(src);
    expect(out).not.toMatch(/style=/);
    expect(out).toContain('tabindex="0"');
    const text = (s: string) => s.replace(/<[^>]+>/g, '');
    expect(text(highlightBlocks(src))).toBe(text(src));
  });
  it('作者手写了标签的代码块原样保留', () => {
    const src = '<pre><code>a <b>b</b></code></pre>';
    expect(highlightBlocks(src)).toBe(src);
  });
});
