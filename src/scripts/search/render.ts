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
  const aside = document.createElement('span');
  aside.className = 'list-row__aside badge';
  aside.textContent = (document.documentElement.lang === 'en' ? TYPE_LABEL_EN : TYPE_LABEL)[hit.type];
  a.append(main, aside);
  return a;
}
