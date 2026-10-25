/**
 * /search/：站内内容（Pagefind 全文 + 拼音首字母，见 search/engine.ts）+ 社区数据库主题（pg_trgm RPC）。
 */
import { searchSite } from './search/engine';
import { hitRow } from './search/render';

const form = document.querySelector<HTMLFormElement>('[data-search-form]')!;
const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
const out = document.querySelector<HTMLElement>('[data-results]')!;
const status = document.querySelector<HTMLElement>('[data-status]')!;
let seq = 0;

// ------------------------------------------------ 论坛数据库主题（pg_trgm RPC）
const forumBox = document.querySelector<HTMLElement>('[data-forum-results]')!;
const forumList = forumBox.querySelector<HTMLElement>('[data-forum-list]')!;
const forumStatus = forumBox.querySelector<HTMLElement>('[data-forum-status]')!;
let forumSeq = 0;
async function runForum(q: string) {
  const seq = ++forumSeq;
  const term = q.trim();
  if (!term) {
    forumBox.hidden = true;
    return;
  }
  forumBox.hidden = false;
  forumStatus.textContent = '正在搜索社区主题…';
  try {
    const [{ getRepository, CATEGORY_NAMES }, { url }, { shortDate }] = await Promise.all([
      import('@/lib/data'),
      import('@/lib/routes'),
      import('./render'),
    ]);
    const hits = await getRepository().forum.search(term, { limit: 20 });
    if (seq !== forumSeq) return;
    forumList.replaceChildren(
      ...hits.map((hit) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'list-row';
        a.href = url.forumThread(hit.id);
        const main = document.createElement('span');
        main.className = 'list-row__main';
        const t = document.createElement('span');
        t.className = 'list-row__title';
        t.textContent = hit.title;
        const s = document.createElement('span');
        s.className = 'list-row__sub';
        s.textContent = `${CATEGORY_NAMES[hit.category] ?? ''} · ${hit.author.name} · ${shortDate(hit.createdAt)} — ${hit.excerpt}`;
        main.append(t, document.createElement('br'), s);
        const aside = document.createElement('span');
        aside.className = 'list-row__aside badge';
        aside.textContent = '社区';
        a.append(main, aside);
        li.append(a);
        return li;
      }),
    );
    forumList.hidden = hits.length === 0;
    forumStatus.textContent = hits.length ? `社区主题 ${hits.length} 条` : `社区主题里没有找到“${term}”。`;
  } catch {
    if (seq !== forumSeq) return;
    forumList.replaceChildren();
    forumList.hidden = true;
    forumStatus.textContent = '社区主题暂时无法搜索（数据服务不可达），上方站内结果不受影响。';
  }
}

async function run(q: string) {
  void runForum(q);
  const my = ++seq;
  const term = q.trim();
  if (!term) {
    out.replaceChildren();
    out.hidden = true;
    status.textContent = '';
    return;
  }
  out.setAttribute('aria-busy', 'true');
  try {
    const { hits } = await searchSite(term, 50);
    if (my !== seq) return;
    out.replaceChildren(
      ...hits.map((h) => {
        const li = document.createElement('li');
        li.append(hitRow(h));
        return li;
      }),
    );
    out.hidden = hits.length === 0;
    status.textContent = hits.length
      ? `“${term}” 共 ${hits.length} 条结果`
      : `没有找到与“${term}”相关的内容。换个更短的关键词试试，如「塔防」「MCP」，也可以输入拼音首字母。`;
  } catch {
    if (my === seq) status.textContent = '搜索索引加载失败，请检查网络后重试。';
  } finally {
    if (my === seq) out.removeAttribute('aria-busy');
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
  timer = setTimeout(() => void run(input.value), 300);
});

const initial = new URLSearchParams(location.search).get('q') || '';
input.value = initial;
if (initial) void run(initial);
