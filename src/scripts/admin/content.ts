/** /admin/content/：UGC 表格（主题 / 回复 / 评论），搜索、筛选、分页、单条与批量操作。 */
import { enhanceTables, serverSort, type ServerSort } from './table2';
import { CATEGORY_NAMES, type ContentRow, type ContentType, type Profile } from '@/lib/data';
import type { ContentSort } from '@/lib/data/admin';
import { crmApi, wfBadge } from './crm-badge';
import { confirmDialog, toast } from '../community/ui';
import {
  adminRepo,
  createSelection,
  dateTime,
  degradedText,
  errorText,
  h,
  initAdmin,
  isAdminRole,
  readParams,
  renderPagination,
  setStatusText,
  writeParams,
} from './shell';
import { actionsCell, plainText, rowMenu, showEmpty, showError, showLoading } from './table';

const DEFAULTS = { type: 'thread', q: '', cat: '', hidden: '', reported: '', author: '', offset: '0' };
const state = readParams(DEFAULTS);
const LIMIT = 25;
const TYPE_LABEL: Record<ContentType, string> = { thread: '主题', reply: '回复', comment: '评论' };

const body = document.querySelector<HTMLElement>('[data-admin-body]')!;
const rows = document.querySelector<HTMLElement>('[data-rows]')!;
const pager = document.querySelector<HTMLElement>('[data-pager]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const bar = document.querySelector<HTMLElement>('[data-bulkbar]')!;
const filters = document.querySelector<HTMLFormElement>('[data-filters]')!;
const typeBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-type-filter] button')];
const chip = document.querySelector<HTMLElement>('[data-author-chip]')!;
const sel = createSelection(body, bar);
const table = document.querySelector<HTMLTableElement>('table[data-table2]')!;
let sort: ServerSort | null = null;
let me: Profile | null = null;
table.addEventListener('table2:sort', (e) => {
  sort = (e as CustomEvent<ServerSort | null>).detail;
  state.offset = '0';
  void load();
});

const input = (n: string) => filters.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;

function paintFilters() {
  for (const b of typeBtns) b.setAttribute('aria-pressed', String(b.dataset.value === state.type));
  // 用户正在输入搜索词时不覆盖（首屏 load 晚于输入时，会把刚填的词冲掉，点「筛选」就成了空搜索）
  if (document.activeElement !== input('q')) input('q').value = state.q;
  input('cat').value = state.cat;
  input('hidden').value = state.hidden;
  input('reported').value = state.reported;
  document.querySelector<HTMLElement>('[data-cat-field]')!.hidden = state.type === 'comment';
  // 表头可能已被数据表 2.0 包成排序按钮：只改文字，不冲掉按钮
  const where = document.querySelector<HTMLElement>('[data-col-where]')!;
  (where.querySelector<HTMLElement>('.th-sort__label') ?? where).textContent =
    state.type === 'comment' ? '页面' : state.type === 'reply' ? '所属主题' : '分类';
  document.querySelector<HTMLElement>('[data-caption]')!.textContent =
    `${TYPE_LABEL[state.type as ContentType]}列表`;
  bar
    .querySelectorAll<HTMLElement>('[data-thread-only]')
    .forEach((b) => (b.hidden = state.type !== 'thread'));
}

function badges(r: ContentRow) {
  return h(
    'span',
    { class: 'badges' },
    wfBadge(r.wfStatus, r.scheduledAt),
    r.pinned ? h('span', { class: 'badge badge--info', text: '置顶' }) : null,
    r.featured ? h('span', { class: 'badge badge--accent', text: '精华' }) : null,
    r.locked && r.type === 'thread' ? h('span', { class: 'badge badge--muted', text: '已锁定' }) : null,
    r.editedAt ? h('span', { class: 'badge', text: '已编辑' }) : null,
  );
}

function btn(text: string, fn: () => Promise<unknown>, cls = '') {
  const b = h('button', { type: 'button', class: `btn btn--sm ${cls}`.trim(), text });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(errorText(e, '操作失败'), 'error');
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

const label = (r: ContentRow) => plainText(r.type === 'thread' ? r.title : r.excerpt, 40);
const COLS = 8;

/** 单条操作：执行 → 提示 → 重新加载；失败提示原因（不吞错） */
async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
    await load();
  } catch (e) {
    toast(errorText(e, '操作失败'), 'error');
  }
}

function row(r: ContentRow) {
  const repo = adminRepo();
  const t = r.type;
  const where =
    t === 'comment'
      ? (r.pageKey ?? '—')
      : t === 'reply'
        ? `${r.title}${r.category ? ` · ${CATEGORY_NAMES[r.category] ?? ''}` : ''}`
        : (CATEGORY_NAMES[r.category ?? ''] ?? '—');
  const titleText = t === 'thread' ? r.title : plainText(r.excerpt, 80) || '（空）';
  const sub = t === 'thread' ? plainText(r.excerpt, 120) : '';
  const main = h(
    'td',
    { class: 'cell-main' },
    r.href
      ? h('a', { class: 'cell-title', href: r.href, text: titleText, title: titleText })
      : h('span', { class: 'cell-title', text: titleText }),
    sub ? h('span', { class: 'cell-sub', text: sub }) : null,
  );
  const quick = btn(r.published ? '隐藏' : '恢复', async () => {
    await repo.setPublished(t, [r.id], !r.published);
    toast(r.published ? '已隐藏。' : '已恢复。');
    await load();
  });
  const menu = rowMenu(label(r), [
    {
      label: r.pinned ? '取消置顶' : '置顶',
      hidden: t !== 'thread',
      run: () =>
        act(() => repo.setThreadFlags([r.id], { pinned: !r.pinned }), r.pinned ? '已取消置顶。' : '已置顶。'),
    },
    {
      label: r.featured ? '取消精华' : '设为精华',
      hidden: t !== 'thread',
      run: () => act(() => repo.setThreadFlags([r.id], { featured: !r.featured }), '已更新。'),
    },
    {
      label: r.locked ? '解锁' : '锁定',
      hidden: t !== 'thread',
      run: () =>
        act(() => repo.setThreadFlags([r.id], { locked: !r.locked }), r.locked ? '已解锁。' : '已锁定。'),
    },
    {
      label: '详情 / 预览 / 版本…',
      run: () =>
        void import('./crm').then(({ openContentDrawer }) =>
          openContentDrawer(r, {
            meId: me?.id ?? null,
            isAdmin: isAdminRole(me),
            onChange: () => void load(),
          }),
        ),
    },
    {
      label: '查看作者',
      hidden: !r.author.id,
      run: () => location.assign(`/admin/users/view/?id=${encodeURIComponent(r.author.id ?? '')}`),
    },
    {
      label: '删除…',
      danger: true,
      run: async () => {
        if (
          !(await confirmDialog(
            `永久删除这条${TYPE_LABEL[t]}「${label(r)}」？${t === 'thread' ? '主题下的回复会一并删除。' : ''}此操作不可撤销。`,
            '删除',
          ))
        )
          return;
        await act(() => repo.deleteContent(t, [r.id]), '已删除。');
      },
    },
  ]);
  return h(
    'tr',
    { 'data-row': true, 'data-id': r.id },
    h(
      'td',
      { class: 'col-check' },
      h(
        'label',
        { class: 'check-hit' },
        h('input', { type: 'checkbox', 'data-select': true, value: r.id, 'aria-label': `选择：${label(r)}` }),
      ),
    ),
    main,
    h(
      'td',
      { 'data-priority': '2' },
      r.author.id
        ? h('a', { href: `/admin/users/view/?id=${encodeURIComponent(r.author.id)}`, text: r.author.name })
        : r.author.name,
    ),
    h('td', { 'data-priority': '3', text: where }),
    h('td', { 'data-priority': '2' }, badges(r)),
    h(
      'td',
      { class: 'num', 'data-priority': '3' },
      r.openReports ? h('span', { class: 'badge badge--danger', text: String(r.openReports) }) : '0',
    ),
    h(
      'td',
      { class: 'nowrap', 'data-priority': '3' },
      h('time', { datetime: r.createdAt, text: dateTime(r.createdAt) }),
    ),
    actionsCell(quick, menu),
  );
}

async function bulk(kind: string) {
  const ids = sel.ids();
  if (!ids.length) return;
  const repo = adminRepo();
  const t = state.type as ContentType;
  try {
    let n = 0;
    if (kind === 'hide') n = await repo.setPublished(t, ids, false);
    else if (kind === 'restore') n = await repo.setPublished(t, ids, true);
    else if (kind === 'draft') n = await (await crmApi()).setWorkflow(t, ids, 'draft');
    else if (kind === 'review') n = await (await crmApi()).setWorkflow(t, ids, 'review');
    else if (kind === 'lock') n = await repo.setThreadFlags(ids, { locked: true });
    else if (kind === 'pin') n = await repo.setThreadFlags(ids, { pinned: true });
    else if (kind === 'delete') {
      if (!(await confirmDialog(`永久删除选中的 ${ids.length} 条${TYPE_LABEL[t]}？此操作不可撤销。`, '删除')))
        return;
      n = await repo.deleteContent(t, ids);
    }
    toast(`已处理 ${n} 条。`);
    sel.clear();
    await load();
  } catch (e) {
    toast(errorText(e, '操作失败'), 'error');
  }
}
bar
  .querySelectorAll<HTMLButtonElement>('[data-bulk]')
  .forEach((b) => b.addEventListener('click', () => void bulk(b.dataset.bulk!)));

for (const b of typeBtns)
  b.addEventListener('click', () => {
    state.type = b.dataset.value!;
    state.offset = '0';
    if (state.type === 'comment') state.cat = '';
    sel.clear();
    void load();
  });
filters.addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = input('q').value.trim();
  state.cat = input('cat').value;
  state.hidden = input('hidden').value;
  state.reported = input('reported').value;
  state.offset = '0';
  void load();
});
bar.querySelector('[data-bulk-cancel]')?.addEventListener('click', () => sel.clear());
filters.addEventListener('reset', (e) => {
  e.preventDefault();
  resetFilters();
});
for (const n of ['cat', 'hidden', 'reported'])
  input(n).addEventListener('change', () => filters.requestSubmit());

async function paintAuthorChip() {
  chip.hidden = !state.author;
  if (!state.author) return chip.replaceChildren();
  const names = await adminRepo()
    .names([state.author])
    .catch(() => ({}) as Record<string, string>);
  const clear = h('button', { type: 'button', 'aria-label': '清除作者筛选' });
  clear.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  clear.addEventListener('click', () => {
    state.author = '';
    state.offset = '0';
    void load();
  });
  chip.replaceChildren(
    h('span', { class: 'chip' }, `作者：${names[state.author] ?? state.author.slice(0, 8)}`, clear),
  );
}

function resetFilters() {
  Object.assign(state, { q: '', cat: '', hidden: '', reported: '', author: '', offset: '0' });
  void load();
}

let seq = 0;
async function load() {
  const my = ++seq;
  paintFilters();
  writeParams(state, DEFAULTS);
  void paintAuthorChip();
  showLoading(rows, COLS);
  setStatusText(status, '正在加载…');
  try {
    const offset = Number(state.offset) || 0;
    const { items, total, degraded } = await adminRepo().listContent({
      type: state.type as ContentType,
      q: state.q,
      category: state.cat || undefined,
      hidden: state.hidden === '' ? undefined : state.hidden === '1',
      reported: state.reported === '' ? undefined : state.reported === '1',
      author: state.author || undefined,
      limit: LIMIT,
      offset,
      sort: (sort?.key as ContentSort) ?? null,
      dir: sort?.dir,
    });
    if (my !== seq) return;
    const filtered = !!(state.q || state.cat || state.hidden || state.reported || state.author);
    if (items.length) rows.replaceChildren(...items.map(row));
    else
      showEmpty(rows, COLS, {
        filtered,
        title: filtered ? '没有符合条件的内容' : `还没有${TYPE_LABEL[state.type as ContentType]}`,
        text: filtered ? '换个关键词，或清除筛选条件再看看。' : '用户发布后会出现在这里。',
        action: filtered ? { label: '清除筛选', run: resetFilters } : undefined,
      });
    sel.bind();
    renderPagination(pager, {
      offset,
      limit: LIMIT,
      total,
      onChange: (o) => {
        state.offset = String(o);
        void load();
      },
    });
    setStatusText(status, degradedText(degraded));
  } catch (e) {
    if (my !== seq) return;
    showError(rows, COLS, e, () => void load());
    pager.replaceChildren();
    setStatusText(status, '');
  } finally {
    if (my === seq) rows.removeAttribute('aria-busy');
  }
}

enhanceTables();
sort = serverSort(table);
void initAdmin().then((p) => {
  me = p;
  if (!p) return;
  void load();
  // 到点的定时发布在旁边结算，不挡列表读取（A15 故障注入：结算请求超时曾让列表多等 8s 才出错误条）；
  // 有内容落地再刷新一次列表。旧库没有 0017 / 结算失败时静默跳过。
  void crmApi()
    .then((c) => c.workflowTick())
    .catch(() => 0)
    .then((n) => {
      if (!n) return;
      toast(`已按计划发布 ${n} 条内容。`);
      void load();
    });
});
