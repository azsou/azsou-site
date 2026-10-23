import { search, TYPE_LABEL, type SearchItem } from '@/lib/search';

const form = document.querySelector<HTMLFormElement>('[data-search-form]')!;
const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
const out = document.querySelector<HTMLElement>('[data-results]')!;
const status = document.querySelector<HTMLElement>('[data-status]')!;
let index: SearchItem[] | null = null;

async function load() {
  if (index) return index;
  const res = await fetch('/search-index.json');
  index = (await res.json()) as SearchItem[];
  return index;
}

function render(items: SearchItem[], q: string) {
  out.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'list-row';
    a.href = it.url;
    const main = document.createElement('span');
    main.className = 'list-row__main';
    const t = document.createElement('span');
    t.className = 'list-row__title';
    t.textContent = it.title;
    const s = document.createElement('span');
    s.className = 'list-row__sub';
    s.textContent = it.meta || it.summary || '';
    main.append(t, document.createElement('br'), s);
    const aside = document.createElement('span');
    aside.className = 'list-row__aside badge';
    aside.textContent = TYPE_LABEL[it.type];
    a.append(main, aside);
    li.append(a);
    out.append(li);
  }
  out.hidden = items.length === 0;
  status.textContent = q
    ? items.length
      ? `“${q}” 共 ${items.length} 条结果`
      : `没有找到与“${q}”相关的内容。试试拼音首字母，如 dwjgjx。`
    : '';
}

async function run(q: string) {
  try {
    const idx = await load();
    render(q.trim() ? search(idx, q) : [], q.trim());
  } catch {
    status.textContent = '搜索索引加载失败，请检查网络后重试。';
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value;
  const u = new URL(location.href);
  if (q.trim()) u.searchParams.set('q', q.trim());
  else u.searchParams.delete('q');
  history.replaceState(null, '', u);
  void run(q);
});
let timer: ReturnType<typeof setTimeout> | undefined;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => void run(input.value), 150);
});

const initial = new URLSearchParams(location.search).get('q') || '';
input.value = initial;
if (initial) void run(initial);
