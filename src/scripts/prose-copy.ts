/**
 * 正文代码块的「复制」按钮（T9.14）：只给带 data-copy 的 <pre>（enhanceProse 标记）加，
 * 复制成功后按钮 aria-label 变「已复制」2 秒；剪贴板不可用时按钮不出现。
 */
const COPY =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export function initCopy(root: ParentNode = document) {
  if (!navigator.clipboard) return;
  const en = document.documentElement.lang === 'en';
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre[data-copy]')) {
    if (pre.parentElement?.classList.contains('code-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.append(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--icon btn--sm code-copy';
    btn.setAttribute('aria-label', en ? 'Copy code' : '复制代码');
    btn.innerHTML = COPY;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.innerHTML = CHECK;
        btn.setAttribute('aria-label', en ? 'Copied' : '已复制');
        setTimeout(() => {
          btn.innerHTML = COPY;
          btn.setAttribute('aria-label', en ? 'Copy code' : '复制代码');
        }, 2000);
      } catch {
        /* 剪贴板被拒绝：保持原样，用户仍可手动选择 */
      }
    });
    wrap.append(btn);
  }
}
initCopy();
