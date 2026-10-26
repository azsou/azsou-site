/**
 * /admin/users/：用户列表（搜索、角色 / 封禁筛选、服务端分页）。
 * P10h：数据表 2.0 工具条（密度 / 列 / 视图 / 导出）、行内改角色（仅管理员；改完立即保存，数据库再校验并记审计）、
 * 「预览」打开右侧详情抽屉（T10.18）。
 */
import type { AdminUser, Profile, Role } from '@/lib/data';
import { toast } from '../community/ui';
import { openUserDrawer } from './drawer';
import { enhanceTables, serverSort, type ServerSort } from './table2';
import { emailDraftDialog } from './crm';
import type { UserSort } from '@/lib/data/admin';
import { url } from '@/lib/routes';
import {
  adminRepo,
  banText,
  dateTime,
  errorText,
  h,
  initAdmin,
  isAdminRole,
  readParams,
  renderPagination,
  ROLE_LABEL,
  setStatusText,
  writeParams,
} from './shell';
import { actionsCell, showEmpty, showError, showLoading } from './table';

const COLS = 9;
let me: Profile | null = null;

/** 行内编辑角色：管理员可改别人（不能改自己）；版主只看徽标 */
function roleCell(u: AdminUser) {
  const badge = h('span', {
    class: `badge${u.role === 'user' ? '' : ' badge--info'}`,
    text: ROLE_LABEL[u.role],
  });
  if (!isAdminRole(me) || u.id === me?.id) return h('td', { 'data-priority': '2' }, badge);
  const sel = h('select', {
    class: 'select select--inline',
    'aria-label': `角色：${u.displayName}`,
    'data-inline-role': true,
  }) as HTMLSelectElement;
  for (const r of ['user', 'moderator', 'admin'] as Role[])
    sel.append(h('option', { value: r, text: ROLE_LABEL[r], selected: r === u.role }));
  sel.addEventListener('change', async () => {
    const next = sel.value as Role;
    sel.disabled = true;
    try {
      await adminRepo().setRole(u.id, next, u.banned);
      u.role = next;
      toast(`已把「${u.displayName}」改为${ROLE_LABEL[next]}。`);
    } catch (e) {
      sel.value = u.role;
      toast(errorText(e, '修改失败，请稍后再试。'));
    } finally {
      sel.disabled = false;
    }
  });
  return h('td', { 'data-priority': '2', class: 'cell-edit' }, sel);
}

const DEFAULTS = { q: '', role: '', banned: '', offset: '0' };
const state = readParams(DEFAULTS);
const LIMIT = 25;
const rows = document.querySelector<HTMLElement>('[data-rows]')!;
const pager = document.querySelector<HTMLElement>('[data-pager]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const filters = document.querySelector<HTMLFormElement>('[data-filters]')!;
const table = document.querySelector<HTMLTableElement>('table[data-table2]')!;
let sort: ServerSort | null = null;
let current: AdminUser[] = [];
table.addEventListener('table2:sort', (e) => {
  sort = (e as CustomEvent<ServerSort | null>).detail;
  state.offset = '0';
  void load();
});
const input = (n: string) => filters.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;

function row(u: AdminUser) {
  return h(
    'tr',
    { class: 'no-check', 'data-row': true, 'data-id': u.id },
    h(
      'td',
      { class: 'cell-main' },
      h('a', { class: 'cell-title', href: url.adminUser(u.id), text: u.displayName }),
      u.email ? h('span', { class: 'cell-sub', text: u.email }) : null,
    ),
    roleCell(u),
    h(
      'td',
      { 'data-priority': '2' },
      u.banned
        ? h('span', { class: 'badge badge--danger', text: banText(u) })
        : h('span', { class: 'badge badge--ok', text: '正常' }),
    ),
    h('td', { class: 'num', 'data-priority': '3', text: String(u.threads) }),
    h('td', { class: 'num', 'data-priority': '3', text: String(u.replies) }),
    h('td', { class: 'num', 'data-priority': '3', text: String(u.comments) }),
    h(
      'td',
      { class: 'num', 'data-priority': '3' },
      u.reportsAgainst ? h('span', { class: 'badge badge--danger', text: String(u.reportsAgainst) }) : '0',
    ),
    h(
      'td',
      { class: 'nowrap', 'data-priority': '3' },
      h('time', { datetime: u.createdAt, text: dateTime(u.createdAt) }),
    ),
    actionsCell(previewBtn(u), null),
  );
}

function previewBtn(u: AdminUser) {
  const b = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--tonal btn--rect',
    'data-preview': true,
    'aria-label': `预览：${u.displayName}`,
    text: '预览',
  });
  b.addEventListener('click', () => void openUserDrawer(u.id, isAdminRole(me)));
  return b;
}

filters.addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = input('q').value.trim();
  state.role = input('role').value;
  state.banned = input('banned').value;
  state.offset = '0';
  void load();
});
for (const n of ['role', 'banned']) input(n).addEventListener('change', () => filters.requestSubmit());

let seq = 0;
async function load() {
  const my = ++seq;
  input('q').value = state.q;
  input('role').value = state.role;
  input('banned').value = state.banned;
  writeParams(state, DEFAULTS);
  showLoading(rows, COLS);
  setStatusText(status, '正在加载…');
  try {
    const offset = Number(state.offset) || 0;
    const { items, total } = await adminRepo().listUsers({
      q: state.q,
      role: (state.role || undefined) as Role | undefined,
      banned: state.banned === '' ? undefined : state.banned === '1',
      limit: LIMIT,
      offset,
      sort: (sort?.key as UserSort) ?? null,
      dir: sort?.dir,
    });
    if (my !== seq) return;
    current = items;
    const filtered = !!(state.q || state.role || state.banned);
    if (items.length) rows.replaceChildren(...items.map(row));
    else
      showEmpty(rows, COLS, {
        filtered,
        title: filtered ? '没有符合条件的用户' : '还没有用户',
        text: filtered ? '换个关键词，或清除筛选条件再看看。' : undefined,
        action: filtered
          ? {
              label: '清除筛选',
              run: () => {
                Object.assign(state, { q: '', role: '', banned: '', offset: '0' });
                void load();
              },
            }
          : undefined,
      });
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
    showError(rows, COLS, errorText(e), () => void load());
    pager.replaceChildren();
    setStatusText(status, '');
  } finally {
    if (my === seq) rows.removeAttribute('aria-busy');
  }
}

enhanceTables();
sort = serverSort(table);
// 批量邮件草稿（仅管理员；只预览 / 复制，后台不发信）
document.querySelector<HTMLButtonElement>('[data-mail-draft]')?.addEventListener('click', () => {
  if (!current.length) return toast('当前页没有用户。', 'error');
  emailDraftDialog(current);
});
void initAdmin().then((p) => {
  me = p;
  if (p) {
    document.querySelectorAll<HTMLElement>('[data-mail-draft]').forEach((b) => (b.hidden = !isAdminRole(p)));
    void load();
  }
});
