/** /admin/users/：用户列表（搜索、角色 / 封禁筛选、分页）。 */
import type { AdminUser, Role } from '@/lib/data';
import { url } from '@/lib/routes';
import {
  adminRepo,
  banText,
  dateTime,
  errorText,
  h,
  initAdmin,
  readParams,
  renderPagination,
  ROLE_LABEL,
  setStatusText,
  writeParams,
} from './shell';
import { showEmpty, showError, showLoading } from './table';

const DEFAULTS = { q: '', role: '', banned: '', offset: '0' };
const state = readParams(DEFAULTS);
const LIMIT = 25;
const rows = document.querySelector<HTMLElement>('[data-rows]')!;
const pager = document.querySelector<HTMLElement>('[data-pager]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const filters = document.querySelector<HTMLFormElement>('[data-filters]')!;
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
    h(
      'td',
      { 'data-priority': '2' },
      h('span', { class: `badge${u.role === 'user' ? '' : ' badge--info'}`, text: ROLE_LABEL[u.role] }),
    ),
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
  );
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
  showLoading(rows, 8);
  setStatusText(status, '正在加载…');
  try {
    const offset = Number(state.offset) || 0;
    const { items, total } = await adminRepo().listUsers({
      q: state.q,
      role: (state.role || undefined) as Role | undefined,
      banned: state.banned === '' ? undefined : state.banned === '1',
      limit: LIMIT,
      offset,
    });
    if (my !== seq) return;
    const filtered = !!(state.q || state.role || state.banned);
    if (items.length) rows.replaceChildren(...items.map(row));
    else
      showEmpty(rows, 8, {
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
    showError(rows, 8, errorText(e), () => void load());
    pager.replaceChildren();
    setStatusText(status, '');
  } finally {
    if (my === seq) rows.removeAttribute('aria-busy');
  }
}

void initAdmin().then((me) => me && load());
