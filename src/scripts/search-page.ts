/**
 * /search/：站内内容（Pagefind 全文 + 拼音首字母，见 search/engine.ts）+ 社区数据库主题（pg_trgm RPC）。
 */
import { searchSite } from './search/engine';
import { hitRow, noResultsNode } from './search/render';
import { TYPE_LABEL, type SearchHit } from '@/lib/search';

/** 社区搜索超时（T9.13）：8 秒内没有响应就显示内联错误条 + 重试 */
export const FORUM_TIMEOUT_MS = 8000;
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

const form = document.querySelector<HTMLFormElement>('[data-search-form]')!;
const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
const out = document.querySelector<HTMLElement>('[data-results]')!;
const status = document.querySelector<HTMLElement>('[data-status]')!;
let seq = 0;

// ------------------------------------------------ 论坛数据库主题（pg_trgm RPC）
const forumBox = document.querySelector<HTMLElement>('[data-forum-results]')!;
const forumList = forumBox.querySelector<HTMLElement>('[data-forum-list]')!;
const forumStatus = forumBox.querySelector<HTMLElement>('[data-forum-status]')!;
const forumError = forumBox.querySelector<HTMLElement>('#forum-error')!;
forumBox.querySelector('[data-forum-retry]')?.addEventListener('click', () => void runForum(input.value));
const tabs = document.querySelector<HTMLElement>('[data-type-tabs]')!;
const emptySlot = document.querySelector<HTMLElement>('[data-empty-slot]')!;
let forumSeq = 0;
async function runForum(q: string) {
  const seq = ++forumSeq;
  const term = q.trim();
  if (!term) {
    forumBox.hidden = true;
    return;
  }
  forumBox.hidden = false;
  forumError.hidden = true;
  forumStatus.textContent = '正在搜索社区主题…';
  try {
    const [{ getRepository, CATEGORY_NAMES }, { url }, { shortDate }] = await Promise.all([
      import('@/lib/data'),
      import('@/lib/routes'),
      import('./render'),
    ]);
    const hits = await withTimeout(getRepository().forum.search(term, { limit: 20 }), FORUM_TIMEOUT_MS);
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
    forumStatus.textContent = '';
    forumError.hidden = false;
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
    const { hits, suggestion } = await searchSite(term, 50);
    if (my !== seq) return;
    out.replaceChildren(
      ...hits.map((h) => {
        const li = document.createElement('li');
        li.dataset.type = h.type;
        li.append(hitRow(h));
        return li;
      }),
    );
    out.hidden = hits.length === 0;
    paintTabs(hits);
    applyType(urlType());
    emptySlot.replaceChildren(...(hits.length ? [] : [noResultsNode(term, suggestion)]));
    status.textContent = hits.length
      ? `「${term}」共 ${hits.length} 条结果`
      : `没有找到与「${term}」相关的内容。`;
    if (hits.length && suggestion) status.textContent += `你要找的是不是「${suggestion}」？`;
  } catch {
    if (my === seq) status.textContent = '搜索索引加载失败，检查网络后再试一次。';
  } finally {
    if (my === seq) out.removeAttribute('aria-busy');
  }
}

/** 类型 Tab + 计数（T9.13）：只列有结果的类型；切换只隐藏 / 显示行，不重新搜索 */
function paintTabs(hits: SearchHit[]) {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  tabs.hidden = counts.size < 2;
  const mk = (type: string, label: string, n: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.type = type;
    b.setAttribute('aria-selected', String(type === 'all'));
    b.tabIndex = type === 'all' ? 0 : -1;
    const c = document.createElement('span');
    c.className = 'tabs__count';
    c.textContent = String(n);
    b.append(label, ' ', c);
    b.addEventListener('click', () => selectTab(type));
    return b;
  };
  tabs.replaceChildren(
    mk('all', '全部', hits.length),
    ...[...counts].map(([t, n]) => mk(t, TYPE_LABEL[t as SearchHit['type']], n)),
  );
}
/** F10 / T027：类型筛选写进 URL（?q=…&type=video），刷新、分享、前进后退都能还原 */
const urlType = () => new URLSearchParams(location.search).get('type') || 'all';
function writeUrl(q: string, type: string, mode: 'push' | 'replace') {
  const u = new URL(location.href);
  if (q.trim()) u.searchParams.set('q', q.trim());
  else u.searchParams.delete('q');
  if (type && type !== 'all') u.searchParams.set('type', type);
  else u.searchParams.delete('type');
  if (u.href === location.href) return;
  if (mode === 'push') history.pushState(null, '', u);
  else history.replaceState(null, '', u);
}
/** 按类型显示；URL 里的类型在本次结果中不存在（未知参数 / 换了关键词）时安全回退到「全部」并改写 URL */
function applyType(type: string) {
  const has = [...tabs.querySelectorAll<HTMLElement>('[role="tab"]')].some((b) => b.dataset.type === type);
  const t = !tabs.hidden && has ? type : 'all';
  showType(t, false);
  if (t !== urlType()) writeUrl(input.value, t, 'replace');
}
function showType(type: string, focus: boolean) {
  for (const b of tabs.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const on = b.dataset.type === type;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const li of out.querySelectorAll<HTMLElement>('li'))
    li.hidden = type !== 'all' && li.dataset.type !== type;
}
/** 点击 = 新历史记录（后退回到上一个类型）；方向键逐个移动只替换当前记录 */
function selectTab(type: string, mode: 'push' | 'replace' = 'push') {
  showType(type, true);
  writeUrl(input.value, type, mode);
}
tabs.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const all = [...tabs.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = all.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  selectTab(next.dataset.type!, 'replace');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value;
  writeUrl(q, urlType(), 'replace');
  void run(q);
});
let timer: ReturnType<typeof setTimeout> | undefined;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // 边输入边把关键词写进 URL（replace，不制造一串历史记录），刷新不丢
    writeUrl(input.value, urlType(), 'replace');
    void run(input.value);
  }, 300);
});
// 前进 / 后退：关键词变了就重搜，只是类型变了就就地切换
addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search).get('q') || '';
  if (q !== input.value.trim()) {
    input.value = q;
    void run(q);
  } else applyType(urlType());
});

const initial = new URLSearchParams(location.search).get('q') || '';
input.value = initial;
if (initial) void run(initial);
