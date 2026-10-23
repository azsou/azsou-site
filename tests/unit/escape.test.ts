import { describe, expect, it } from 'vitest';
import { escapeHtml, excerpt, stripHtml, textToHtml } from '@/lib/escape';

describe('escape', () => {
  it('escapes HTML special chars', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });
  it('turns user text into safe paragraphs', () => {
    expect(textToHtml('第一段\n换行\n\n<b>第二段</b>')).toBe('<p>第一段<br>换行</p><p>&lt;b&gt;第二段&lt;/b&gt;</p>');
  });
  it('strips tags and decodes entities', () => {
    expect(stripHtml('<p>a &amp; b</p><div class="callout"><b>结论：</b>c</div>')).toBe('a & b 结论： c');
  });
  it('truncates excerpts with an ellipsis', () => {
    expect(excerpt('<p>' + '字'.repeat(200) + '</p>', 10)).toBe('字'.repeat(9) + '…');
    expect(excerpt('<p>短</p>', 10)).toBe('短');
  });
});
