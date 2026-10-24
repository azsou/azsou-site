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
      { class: 'cell-main', 'data-label': '用户' },
      h('a', { class: 'cell-title', href: url.adminUser(u.id), text: u.displayName }),
      u.email ? h('span', { class: 'cell-sub', text: u.email }) : null,
    ),
    h(
      'td',
      { 'data-label': '角色' },
      h('span', { class: `badge${u.role === 'user' ? '' : ' badge--info'}`, text: ROLE_LABEL[u.role] }),
    ),
    h(
      'td',
      { 'data-label': '状态' },
      u.banned
        ? h('span', { class: 'badge badge--danger', text: banText(u) })
        : h('span', { class: 'badge badge--ok', text: '正常' }),
    ),
    h('td', { class: 'num', 'data-label': '主题', text: String(u.threads) }),
    h('td', { class: 'num', 'data-label': '回复', text: String(u.replies) }),
    h('td', { class: 'num', 'data-label': '评论', text: String(u.comments) }),
    h(
      'td',
      { class: 'num', 'data-label': '被举报' },
      u.reportsAgainst ? h('span', { class: 'badge badge--danger', text: String(u.reportsAgainst) }) : '0',
    ),
    h(
      'td',
      { class: 'nowrap', 'data-label': '注册时间' },
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
  rows.setAttribute('aria-busy', 'true');
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
    rows.replaceChildren(
      ...(items.length
        ? items.map(row)
        : [
            h(
              'tr',
              { class: 'no-check' },
              h('td', { colspan: '8', class: 'table-empty', text: '没有符合条件的用户。' }),
            ),
          ]),
    );
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
