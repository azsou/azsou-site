import { TYPE_LABEL, TYPE_LABEL_EN, type SearchHit } from '@/lib/search';

/** 摘要片段 → DOM（textContent + <mark>，不使用 innerHTML） */
export function excerptNode(hit: SearchHit): HTMLElement {
  const s = document.createElement('span');
  s.className = 'list-row__sub';
  if (hit.excerpt?.length) {
    for (const p of hit.excerpt) {
      if (p.mark) {
        const m = document.createElement('mark');
        m.textContent = p.text;
        s.append(m);
      } else s.append(p.text);
    }
  } else s.textContent = hit.sub;
  return s;
}

/** 一行结果：标题 + 摘要 + 类型徽章。as=option 时用于面板（listbox 里的 a[role=option]） */
export function hitRow(hit: SearchHit, opts: { id?: string; option?: boolean } = {}): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'list-row';
  a.href = hit.url;
  if (opts.id) a.id = opts.id;
  if (opts.option) {
    a.setAttribute('role', 'option');
    a.setAttribute('aria-selected', 'false');
    a.tabIndex = -1;
  }
  const main = document.createElement('span');
  main.className = 'list-row__main';
  const t = document.createElement('span');
  t.className = 'list-row__title';
  t.textContent = hit.title;
  main.append(t, document.createElement('br'), excerptNode(hit));
  const icon = document.createElement('span');
  icon.className = `hit-icon hit-icon--${hit.type}`;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = svg(TYPE_ICON[hit.type] ?? TYPE_ICON.page);
  a.dataset.type = hit.type;
  const aside = document.createElement('span');
  aside.className = 'list-row__aside badge';
  aside.textContent = (document.documentElement.lang === 'en' ? TYPE_LABEL_EN : TYPE_LABEL)[hit.type];
  a.append(icon, main, aside);
  return a;
}

/** 结果行的类型图标（Lucide 路径，与 Icon.astro 同一套：24 网格、描边 1.75）。
 *  为控制搜索脚本体积不整表引入 LUCIDE；tests/unit/icons.test.ts 校验每一项与 src/lib/lucide.ts 逐字一致（D04 单一来源） */
export const TYPE_ICON: Record<string, string> = {
  app: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  tool: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  video: '<polygon points="6 3 20 12 6 21 6 3"/>',
  game: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  article:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  work: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  thread: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  page: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
};
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * 无结果态（DESIGN-SYSTEM §12，搜索页与 Ctrl K 面板共用）：图标 + 标题 + 说明 + 错拼建议 + 两个去处。
 * onSuggest 给了就用按钮（面板里就地重搜），否则是指向 /search/?q= 的链接。
 */
export function noResultsNode(term: string, suggestion: string | null, onSuggest?: (q: string) => void) {
  const en = document.documentElement.lang === 'en';
  const box = document.createElement('div');
  box.className = 'empty-state search-empty';
  box.setAttribute('data-search-empty', '');
  const icon = document.createElement('span');
  icon.className = 'empty-state__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>').replace(
    /width="20" height="20"/,
    'width="48" height="48"',
  );
  const title = document.createElement('p');
  title.className = 'empty-state__title';
  title.textContent = en ? `No results for “${term}”` : `没有找到「${term}」`;
  box.append(icon, title);
  if (suggestion) {
    const p = document.createElement('p');
    p.className = 'search-empty__suggest';
    p.append(en ? 'Did you mean ' : '你要找的是不是');
    const target = onSuggest ? document.createElement('button') : document.createElement('a');
    target.className = 'link';
    target.textContent = en ? suggestion : `「${suggestion}」`;
    target.setAttribute('data-suggest', suggestion);
    if (target instanceof HTMLAnchorElement) target.href = `/search/?q=${encodeURIComponent(suggestion)}`;
    else {
      (target as HTMLButtonElement).type = 'button';
      target.addEventListener('click', () => onSuggest!(suggestion));
    }
    p.append(target, en ? '?' : '？');
    box.append(p);
  }
  const text = document.createElement('p');
  text.className = 'empty-state__text';
  text.textContent = en
    ? 'Try a shorter keyword, or browse the catalogs.'
    : '换个更短的关键词，或输入拼音首字母；也可以直接逛逛目录。';
  const links = document.createElement('p');
  links.className = 'btn-row search-empty__links';
  for (const [href, label] of en
    ? [
        ['/en/ai/', 'AI tools'],
        ['/en/apps/', 'Apps'],
      ]
    : [
        ['/ai/', 'AI 工具目录'],
        ['/apps/', '全部应用'],
      ]) {
    const a = document.createElement('a');
    a.className = 'chip';
    a.href = href;
    a.textContent = label;
    links.append(a);
  }
  box.append(text, links);
  return box;
}
