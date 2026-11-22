/**
 * 正文 HTML 增强（T9.14，DESIGN-SYSTEM §22.4）：构建期对受信的文章 HTML 做三件事——
 *  - <table> 外包 <section class="table-wrap">（窄屏横向滚动，可聚焦、有名称）；
 *  - <pre> 加 tabindex="0" + aria-label（键盘可滚动的代码块，不折行）+ data-copy（客户端加「复制」按钮）；
 *  - 代码块构建期高亮（highlight.ts，只输出 tok-* 类名，不写内联 style）；
 *  - 脚注区（<section class="footnotes"> 或 <ol class="footnotes">）补「注释」标题。
 * 只处理文章自己的 HTML（内容集合，非用户输入）；用户内容走 markdown.ts + sanitize。
 */
import { highlightBlocks } from './highlight';

export function enhanceProse(html: string, lang: 'zh' | 'en' = 'zh'): string {
  const codeLabel = lang === 'en' ? 'Code' : '代码';
  const tableLabel = lang === 'en' ? 'Table (scrollable)' : '表格（可横向滚动）';
  return (
    highlightBlocks(html)
      .replace(/<table\b/g, `<section class="table-wrap" tabindex="0" aria-label="${tableLabel}"><table`)
      .replace(/<\/table>/g, '</table></section>')
      // 任务列表：复选框包进 <label>，读屏读得出每一项（axe label）
      .replace(/<li>(\s*<input type="checkbox"[^>]*>)([\s\S]*?)<\/li>/g, '<li><label>$1$2</label></li>')
      .replace(/<pre(?![^>]*tabindex)([^>]*)>/g, `<pre$1 tabindex="0" aria-label="${codeLabel}" data-copy>`)
      .replace(
        /<(section|ol) class="footnotes"([^>]*)>/g,
        (m) => `<h2 class="footnotes__title">${lang === 'en' ? 'Notes' : '注释'}</h2>${m}`,
      )
  );
}
