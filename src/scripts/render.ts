/** island 共用的 DOM 渲染：用户内容只经 textContent，永不 innerHTML。 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function initials(name: string): string {
  const n = name.trim();
  if (!n) return '?';
  const words = n.split(/\s+/);
  if (words.length > 1 && /^[A-Za-z]/.test(n)) return (words[0][0] + words[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function paragraphs(text: string): HTMLElement {
  const wrap = el('div', 'comment__body');
  for (const block of text.trim().split(/\n{2,}/)) {
    const p = el('p');
    block.split('\n').forEach((line, i) => {
      if (i) p.append(document.createElement('br'));
      p.append(document.createTextNode(line));
    });
    wrap.append(p);
  }
  return wrap;
}

export function commentNode(c: { author: { name: string }; createdAt: string; body: string }): HTMLElement {
  const li = el('li', 'comment');
  li.dataset.source = 'db';
  li.append(el('span', 'avatar', initials(c.author.name)));
  const main = el('div');
  const head = el('div', 'comment__head');
  head.append(el('b', undefined, c.author.name));
  const t = el('time', undefined, shortDate(c.createdAt));
  t.dateTime = c.createdAt;
  head.append(t);
  main.append(head, paragraphs(c.body));
  li.append(main);
  return li;
}

export function setStatus(root: Element, text: string, state: 'loading' | 'online' | 'offline') {
  const s = root.querySelector<HTMLElement>('[data-status]');
  if (s) {
    s.textContent = text;
    s.dataset.state = state;
  }
  (root as HTMLElement).dataset.state = state;
}
