/** /admin/reports/：举报队列（筛选、目标预览、单条 / 批量处理、处理说明、分页）。 */
import type { ModAction, Report, ReportTarget, TargetPreview } from '@/lib/data';
import { REPORT_REASONS, toast } from '../community/ui';
import {
  adminRepo,
  createSelection,
  dateTime,
  errorText,
  field,
  formDialog,
  h,
  initAdmin,
  readParams,
  refreshOpenCount,
  renderPagination,
  select,
  setStatusText,
  writeParams,
} from './shell';
import { stateBlock } from './table';

const list = document.querySelector<HTMLElement>('[data-list]')!;
const pager = document.querySelector<HTMLElement>('[data-pager]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const bar = document.querySelector<HTMLElement>('[data-bulkbar]')!;
const statusBtns = [...document.querySelectorAll<HTMLButtonElement>('[data-status-filter] button')];
const typeSel = document.querySelector<HTMLSelectElement>('[data-type-filter]')!;
const topAll = document.querySelector<HTMLInputElement>('[data-select-all]')!;
const selectRow = document.querySelector<HTMLElement>('[data-select-row]')!;

const DEFAULTS = { status: 'open', type: '', offset: '0' };
const state = readParams(DEFAULTS);
const LIMIT = 20;
const REASON = Object.fromEntries(REPORT_REASONS);
const TYPE: Record<ReportTarget, string> = {
  thread: '主题',
  reply: '回复',
  comment: '评论',
  profile: '用户',
  review: '应用评价',
};
const STATUS: Record<string, [string, string]> = {
  open: ['待处理', 'badge--warn'],
  resolved: ['已处理', 'badge--ok'],
  dismissed: ['已驳回', 'badge--muted'],
};

const sel = createSelection(document.querySelector<HTMLElement>('[data-admin-body]')!, bar);

const ACTIONS: [string, string][] = [
  ['dismiss', '驳回（未发现违规）'],
  ['none', '标记为已处理（不做其他操作）'],
  ['hide', '隐藏被举报内容'],
  ['lock', '锁定所在主题'],
  ['warn', '警告作者（发送站内通知）'],
  ['ban', '封禁作者'],
];

function preview(r: Report, p: TargetPreview | undefined) {
  if (!p || !p.exists)
    return h(
      'div',
      { class: 'report__target' },
      h('strong', { text: `${TYPE[r.targetType]} · 已删除或不存在` }),
      h('p', { class: 'muted', text: r.targetId }),
    );
  const badges = h(
    'span',
    { class: 'badges' },
    h('span', { class: 'badge', text: TYPE[r.targetType] }),
    p.published ? null : h('span', { class: 'badge badge--danger', text: '已隐藏' }),
    p.locked ? h('span', { class: 'badge badge--muted', text: '已锁定' }) : null,
  );
  const authorLink = p.author.id
    ? h('a', { href: `/admin/users/view/?id=${encodeURIComponent(p.author.id)}`, text: p.author.name })
    : h('span', { text: p.author.name });
  return h(
    'div',
    { class: 'report__target' },
    badges,
    ' ',
    p.title && r.targetType !== 'reply' ? h('strong', { text: p.title }) : null,
    h('p', { text: p.excerpt || '（无正文）' }),
    h(
      'p',
      { class: 'muted' },
      '作者：',
      authorLink,
      p.href ? ' · ' : '',
      p.href ? h('a', { href: p.href, text: '打开原文' }) : null,
    ),
  );
}

function row(r: Report, p: TargetPreview | undefined, names: Record<string, string>) {
  const [label, cls] = STATUS[r.status];
  const open = r.status === 'open';
  const check = open
    ? h(
        'div',
        { class: 'report__check' },
        h('input', {
          type: 'checkbox',
          'data-select': true,
          value: r.id,
          'aria-label': `选择举报：${REASON[r.reason] ?? r.reason}`,
        }),
      )
    : h('div', { class: 'report__check' });
  const actions = open
    ? h(
        'div',
        { class: 'row-actions' },
        p?.exists && r.targetType !== 'profile' && p.published
          ? actionBtn('隐藏内容', () => handle([r.id], 'hide', '隐藏被举报内容'))
          : null,
        actionBtn('驳回', () => handle([r.id], 'dismiss', '驳回举报')),
        actionBtn('更多处理…', () => handleDialog([r.id]), true),
      )
    : null;
  return h(
    'li',
    { class: 'report', 'data-row': true, 'data-id': r.id },
    check,
    h(
      'div',
      {},
      h(
        'div',
        { class: 'report__head' },
        h('span', { class: 'badge badge--danger', text: REASON[r.reason] ?? r.reason }),
        h('span', { class: `badge ${cls}`, text: label }),
        h('span', { text: `举报人：${r.reporter ? (names[r.reporter] ?? '用户') : '已注销用户'}` }),
        h('time', { datetime: r.createdAt, text: dateTime(r.createdAt) }),
      ),
      r.detail ? h('p', { class: 'report__detail', text: r.detail }) : null,
      preview(r, p),
      !open
        ? h('p', {
            class: 'report__note',
            text: `处理说明：${r.resolutionNote || '（无）'} · ${dateTime(r.resolvedAt)}`,
          })
        : null,
      actions,
    ),
  );
}

function actionBtn(text: string, fn: () => void, primary = false) {
  const b = h('button', { type: 'button', class: `btn btn--sm${primary ? ' btn--primary' : ''}`, text });
  b.addEventListener('click', fn);
  return b;
}

/** 快捷处理（只确认一次，说明可选） */
async function handle(ids: string[], action: string, title: string) {
  const note = h('textarea', { name: 'note', maxlength: '500', rows: '3' });
  const form = await formDialog({
    title: ids.length > 1 ? `${title}（${ids.length} 条）` : title,
    body: [field('处理说明（选填，写入审计日志）', note)],
    submit: action === 'dismiss' ? '驳回' : '确定',
    danger: action === 'hide',
    run: (f) => submit(ids, action, (f.elements.namedItem('note') as HTMLTextAreaElement).value, null),
  });
  if (form) done(ids.length);
}

async function handleDialog(ids: string[]) {
  const act = select('action', ACTIONS, 'hide');
  const days = select(
    'days',
    [
      ['1', '1 天'],
      ['3', '3 天'],
      ['7', '7 天'],
      ['30', '30 天'],
      ['', '永久'],
    ],
    '7',
  );
  const daysField = field('封禁时长', days);
  daysField.hidden = true;
  act.addEventListener('change', () => (daysField.hidden = act.value !== 'ban'));
  const note = h('textarea', { name: 'note', maxlength: '500', rows: '3' });
  const form = await formDialog({
    title: ids.length > 1 ? `处理 ${ids.length} 条举报` : '处理举报',
    body: [
      field('处理方式', act),
      daysField,
      field('处理说明', note, '写入审计日志；警告 / 封禁时作为原因发送给用户（最多 500 字）。'),
    ],
    submit: '提交',
    validate: () => ([...note.value.trim()].length > 500 ? '处理说明最多 500 字。' : null),
    run: () =>
      submit(ids, act.value, note.value, act.value === 'ban' && days.value ? Number(days.value) : null),
  });
  if (form) done(ids.length);
}

async function submit(ids: string[], action: string, note: string, banDays: number | null) {
  const repo = adminRepo();
  if (action === 'dismiss') await repo.handleReports(ids, 'dismissed', { note });
  else await repo.handleReports(ids, 'resolved', { note, action: action as ModAction, banDays });
}

function done(n: number) {
  toast(n > 1 ? `已处理 ${n} 条举报。` : '举报已处理。');
  sel.clear();
  void load();
  void refreshOpenCount();
}

bar.querySelector('[data-bulk="dismiss"]')!.addEventListener('click', () => {
  const ids = sel.ids();
  if (ids.length) void handle(ids, 'dismiss', '批量驳回举报');
});
bar.querySelector('[data-bulk="handle"]')!.addEventListener('click', () => {
  const ids = sel.ids();
  if (ids.length) void handleDialog(ids);
});

function paintFilters() {
  for (const b of statusBtns) b.setAttribute('aria-pressed', String(b.dataset.value === state.status));
  typeSel.value = state.type;
  selectRow.hidden = state.status !== 'open' && state.status !== 'all';
}
for (const b of statusBtns)
  b.addEventListener('click', () => {
    state.status = b.dataset.value!;
    state.offset = '0';
    void load();
  });
typeSel.addEventListener('change', () => {
  state.type = typeSel.value;
  state.offset = '0';
  void load();
});

let seq = 0;
async function load() {
  const my = ++seq;
  paintFilters();
  writeParams(state, DEFAULTS);
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(h('li', { class: 'state-li' }, stateBlock('loading')));
  setStatusText(status, '正在加载…');
  try {
    const repo = adminRepo();
    const offset = Number(state.offset) || 0;
    const { items, total } = await repo.listReports({
      status: state.status as 'open',
      targetType: (state.type || undefined) as ReportTarget | undefined,
      limit: LIMIT,
      offset,
    });
    const [previews, names] = await Promise.all([
      repo.previews(items.map((r) => ({ type: r.targetType, id: r.targetId }))),
      repo.names(items.map((r) => r.reporter ?? '').filter(Boolean)),
    ]);
    if (my !== seq) return;
    list.replaceChildren(
      ...(items.length
        ? items.map((r) => row(r, previews[`${r.targetType}:${r.targetId}`], names))
        : [
            h(
              'li',
              { class: 'state-li panel' },
              stateBlock('empty', {
                title: state.status === 'open' ? '没有待处理的举报。' : '没有符合条件的举报。',
                text:
                  state.status === 'open'
                    ? '新的举报会出现在这里，侧栏会显示待处理数。'
                    : '切换上方的状态或类型再看看。',
              }),
            ),
          ]),
    );
    topAll.disabled = !items.some((r) => r.status === 'open');
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
    list.replaceChildren(
      h('li', { class: 'state-li' }, stateBlock('error', { text: errorText(e), retry: () => void load() })),
    );
    pager.replaceChildren();
    setStatusText(status, '');
  } finally {
    if (my === seq) list.removeAttribute('aria-busy');
  }
}

void initAdmin().then((me) => me && load());
