/** /admin/content/：UGC 表格（主题 / 回复 / 评论），搜索、筛选、分页、单条与批量操作。 */
import { CATEGORY_NAMES, type ContentRow, type ContentType } from '@/lib/data';
import { confirmDialog, toast } from '../community/ui';
import {
  adminRepo,
  createSelection,
  dateTime,
  errorText,
  h,
  initAdmin,
  readParams,
  renderPagination,
  setStatusText,
  writeParams,
} from './shell';

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

const input = (n: string) => filters.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;

function paintFilters() {
  for (const b of typeBtns) b.setAttribute('aria-pressed', String(b.dataset.value === state.type));
  input('q').value = state.q;
  input('cat').value = state.cat;
  input('hidden').value = state.hidden;
  input('reported').value = state.reported;
  document.querySelector<HTMLElement>('[data-cat-field]')!.hidden = state.type === 'comment';
  document.querySelector<HTMLElement>('[data-col-where]')!.textContent =
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
    r.published
      ? h('span', { class: 'badge badge--ok', text: '已发布' })
      : h('span', { class: 'badge badge--danger', text: '已隐藏' }),
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

const label = (r: ContentRow) => (r.type === 'thread' ? r.title : r.excerpt).slice(0, 40);

function row(r: ContentRow) {
  const repo = adminRepo();
  const t = r.type;
  const where =
    t === 'comment'
      ? (r.pageKey ?? '—')
      : t === 'reply'
        ? `${r.title}${r.category ? ` · ${CATEGORY_NAMES[r.category] ?? ''}` : ''}`
        : (CATEGORY_NAMES[r.category ?? ''] ?? '—');
  const main = h(
    'td',
    { class: 'cell-main', 'data-label': '内容' },
    r.href
      ? h('a', {
          class: 'cell-title',
          href: r.href,
          text: t === 'thread' ? r.title : r.excerpt.slice(0, 80) || '（空）',
        })
      : h('span', { class: 'cell-title', text: r.title }),
    t === 'thread' ? h('span', { class: 'cell-sub', text: r.excerpt.slice(0, 120) }) : null,
  );
  const actions = h(
    'td',
    { 'data-label': '操作' },
    h(
      'div',
      { class: 'row-actions' },
      btn(r.published ? '隐藏' : '恢复', async () => {
        await repo.setPublished(t, [r.id], !r.published);
        toast(r.published ? '已隐藏。' : '已恢复。');
        await load();
      }),
      t === 'thread'
        ? btn(r.pinned ? '取消置顶' : '置顶', async () => {
            await repo.setThreadFlags([r.id], { pinned: !r.pinned });
            await load();
          })
        : null,
      t === 'thread'
        ? btn(r.featured ? '取消精华' : '精华', async () => {
            await repo.setThreadFlags([r.id], { featured: !r.featured });
            await load();
          })
        : null,
      t === 'thread'
        ? btn(r.locked ? '解锁' : '锁定', async () => {
            await repo.setThreadFlags([r.id], { locked: !r.locked });
            await load();
          })
        : null,
      btn(
        '删除',
        async () => {
          if (
            !(await confirmDialog(
              `永久删除这条${TYPE_LABEL[t]}「${label(r)}」？${t === 'thread' ? '主题下的回复会一并删除。' : ''}此操作不可撤销。`,
              '删除',
            ))
          )
            return;
          await repo.deleteContent(t, [r.id]);
          toast('已删除。');
          await load();
        },
        'btn--danger',
      ),
    ),
  );
  return h(
    'tr',
    { 'data-row': true, 'data-id': r.id },
    h(
      'td',
      { class: 'col-check' },
      h('input', { type: 'checkbox', 'data-select': true, value: r.id, 'aria-label': `选择：${label(r)}` }),
    ),
    main,
    h(
      'td',
      { 'data-label': '作者' },
      r.author.id
        ? h('a', { href: `/admin/users/view/?id=${encodeURIComponent(r.author.id)}`, text: r.author.name })
        : r.author.name,
    ),
    h('td', { 'data-label': t === 'comment' ? '页面' : t === 'reply' ? '所属主题' : '分类', text: where }),
    h('td', { 'data-label': '状态' }, badges(r)),
    h(
      'td',
      { class: 'num', 'data-label': '举报' },
      r.openReports ? h('span', { class: 'badge badge--danger', text: String(r.openReports) }) : '0',
    ),
    h(
      'td',
      { class: 'nowrap', 'data-label': '时间' },
      h('time', { datetime: r.createdAt, text: dateTime(r.createdAt) }),
    ),
    actions,
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

let seq = 0;
async function load() {
  const my = ++seq;
  paintFilters();
  writeParams(state, DEFAULTS);
  void paintAuthorChip();
  rows.setAttribute('aria-busy', 'true');
  setStatusText(status, '正在加载…');
  try {
    const offset = Number(state.offset) || 0;
    const { items, total } = await adminRepo().listContent({
      type: state.type as ContentType,
      q: state.q,
      category: state.cat || undefined,
      hidden: state.hidden === '' ? undefined : state.hidden === '1',
      reported: state.reported === '' ? undefined : state.reported === '1',
      author: state.author || undefined,
      limit: LIMIT,
      offset,
    });
    if (my !== seq) return;
    rows.replaceChildren(
      ...(items.length
        ? items.map(row)
        : [
            h(
              'tr',
              { class: 'no-check' },
              h('td', { colspan: '8', class: 'table-empty', text: '没有符合条件的内容。' }),
            ),
          ]),
    );
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
    setStatusText(status, '');
  } catch (e) {
    if (my !== seq) return;
    rows.replaceChildren();
    setStatusText(status, errorText(e), 'error');
  } finally {
    if (my === seq) rows.removeAttribute('aria-busy');
  }
}

void initAdmin().then((me) => me && load());
