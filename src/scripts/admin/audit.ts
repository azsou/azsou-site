/** /admin/audit/：审计日志（管理员），筛选、分页、导出 CSV（当前筛选，最多 5000 条）。 */
import type { AuditEntry, AuditQuery } from '@/lib/data';
import { auditLabel } from '@/lib/admin-nav';
import { auditSummary } from '@/lib/admin-utils';
import { toCsv } from '@/lib/csv';
import { url } from '@/lib/routes';
import { toast } from '../community/ui';
import {
  adminRepo,
  dateTime,
  download,
  errorText,
  h,
  initAdmin,
  readParams,
  renderPagination,
  ROLE_LABEL,
  setStatusText,
  stamp,
  writeParams,
} from './shell';
import { showEmpty, showError, showLoading } from './table';

const DEFAULTS = { action: '', target: '', actor: '', from: '', to: '', offset: '0' };
const state = readParams(DEFAULTS);
const LIMIT = 50;
const rows = document.querySelector<HTMLElement>('[data-rows]')!;
const pager = document.querySelector<HTMLElement>('[data-pager]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const filters = document.querySelector<HTMLFormElement>('[data-filters]')!;
const input = (n: string) => filters.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement;

/** 日期输入（上海时区的一天）→ ISO；to 取次日 0 点（不含） */
const day = (d: string, next = false) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = new Date(`${d}T00:00:00+08:00`).getTime() + (next ? 86_400_000 : 0);
  return new Date(t).toISOString();
};
const query = (): AuditQuery => ({
  action: state.action || undefined,
  targetId: state.target || undefined,
  actor: state.actor || undefined,
  from: day(state.from),
  to: day(state.to, true),
});

function targetCell(e: AuditEntry) {
  if (!e.targetId) return '—';
  const t = e.targetType;
  const href =
    t === 'profile' ? url.adminUser(e.targetId) : t === 'thread' ? url.forumThread(e.targetId) : null;
  const label = `${t ?? ''} ${e.targetId.length > 20 ? `${e.targetId.slice(0, 8)}…` : e.targetId}`.trim();
  return href
    ? h('a', { href, text: label, title: e.targetId })
    : h('span', { text: label, title: e.targetId });
}

function row(e: AuditEntry, names: Record<string, string>) {
  return h(
    'tr',
    { class: 'no-check' },
    h(
      'td',
      { class: 'nowrap', 'data-priority': '2' },
      h('time', { datetime: e.createdAt, text: dateTime(e.createdAt) }),
    ),
    h(
      'td',
      { 'data-priority': '2' },
      e.actor
        ? h('a', { href: url.adminUser(e.actor), text: names[e.actor] ?? e.actor.slice(0, 8) })
        : '系统',
      e.actorRole ? h('span', { class: 'cell-sub', text: ROLE_LABEL[e.actorRole] ?? e.actorRole }) : null,
    ),
    h(
      'td',
      { class: 'cell-main' },
      h('span', { class: 'cell-title', text: auditLabel(e.action) }),
      h('span', { class: 'cell-sub', text: e.action }),
    ),
    h('td', { 'data-priority': '3' }, targetCell(e)),
    h(
      'td',
      { 'data-priority': '3' },
      h('span', { class: 'detail-json', text: auditSummary(e.detail) || '—' }),
    ),
  );
}

filters.addEventListener('submit', (ev) => {
  ev.preventDefault();
  for (const k of ['action', 'target', 'actor', 'from', 'to'] as const) state[k] = input(k).value.trim();
  state.offset = '0';
  void load();
});
input('action').addEventListener('change', () => filters.requestSubmit());

filters.querySelector<HTMLButtonElement>('[data-export]')!.addEventListener('click', async (ev) => {
  const b = ev.currentTarget as HTMLButtonElement;
  b.disabled = true;
  try {
    const repo = adminRepo();
    const all: AuditEntry[] = [];
    for (let offset = 0; offset < 5000; offset += 1000) {
      const { items } = await repo.audit({ ...query(), limit: 1000, offset });
      all.push(...items);
      if (items.length < 1000) break;
    }
    const names = await repo.names(all.map((e) => e.actor ?? '').filter(Boolean));
    const csv = toCsv(
      all.map((e) => ({
        id: e.id,
        created_at: e.createdAt,
        actor: e.actor ?? '',
        actor_name: e.actor ? (names[e.actor] ?? '') : '',
        actor_role: e.actorRole ?? '',
        action: e.action,
        action_label: auditLabel(e.action),
        target_type: e.targetType ?? '',
        target_id: e.targetId ?? '',
        detail: e.detail,
      })),
      [
        'id',
        'created_at',
        'actor',
        'actor_name',
        'actor_role',
        'action',
        'action_label',
        'target_type',
        'target_id',
        'detail',
      ],
    );
    download(`audit-log-${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
    toast(`已导出 ${all.length} 条。`);
  } catch (e) {
    toast(errorText(e, '导出失败'), 'error');
  } finally {
    b.disabled = false;
  }
});

let seq = 0;
async function load() {
  const my = ++seq;
  for (const k of ['action', 'target', 'actor', 'from', 'to'] as const) input(k).value = state[k];
  writeParams(state, DEFAULTS);
  showLoading(rows, 5);
  setStatusText(status, '正在加载…');
  try {
    const repo = adminRepo();
    const offset = Number(state.offset) || 0;
    const { items, total } = await repo.audit({ ...query(), limit: LIMIT, offset });
    const names = await repo.names(items.map((e) => e.actor ?? '').filter(Boolean));
    if (my !== seq) return;
    const filtered = ['action', 'target', 'actor', 'from', 'to'].some(
      (k) => !!state[k as keyof typeof state],
    );
    if (items.length) rows.replaceChildren(...items.map((e) => row(e, names)));
    else
      showEmpty(rows, 5, {
        filtered,
        title: filtered ? '没有符合条件的记录' : '还没有审计记录',
        text: filtered ? '调整动作、对象或日期范围再看看。' : '版主与管理员的操作会记录在这里。',
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
    showError(rows, 5, e, () => void load());
    pager.replaceChildren();
    setStatusText(status, '');
  } finally {
    if (my === seq) rows.removeAttribute('aria-busy');
  }
}

void initAdmin().then((me) => me && load());
