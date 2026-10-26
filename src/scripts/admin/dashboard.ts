/**
 * /admin/：KPI 卡片（P10h：近 30 天迷你趋势 SVG）+ 30 天柱状图（SVG，无图表库）+ 可访问的数据表 +
 * 待办队列 + 内容构成；顺便清理到期封禁。全部来自 admin_stats 的真实数字，失败时错误态 + 重试。
 * SVG 用 setAttribute 写几何属性（不是 style），符合严格 CSP。
 */
import type { AdminStats } from '@/lib/data';
import { groupedBars } from '@/lib/chart';
import { toast } from '../community/ui';
import { adminRepo, errorText, h, initAdmin, setStatusText } from './shell';
import { stateBlock } from './table';

const statsEl = document.querySelector<HTMLElement>('[data-stats]')!;
const chartEl = document.querySelector<HTMLElement>('[data-chart]')!;
const tableEl = document.querySelector<HTMLElement>('[data-chart-table]')!;
const status = document.querySelector<HTMLElement>('[data-status]');
const todoEl = document.querySelector<HTMLElement>('[data-todo]');
const mixEl = document.querySelector<HTMLElement>('[data-mix]');

const fmt = (n: number) => n.toLocaleString('zh-CN');

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** 迷你趋势（装饰，读屏读卡片文字；数据表在下面的「查看数据表」里） */
export function sparkPath(values: number[], w = 100, hgt = 32): { line: string; area: string } {
  if (!values.length) return { line: '', area: '' };
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, hgt - 2 - (v / max) * (hgt - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w} ${hgt} L0 ${hgt} Z` };
}
function spark(values: number[]) {
  const { line, area } = sparkPath(values);
  const root = svg('svg', {
    class: 'stat__spark',
    viewBox: '0 0 100 32',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  root.append(svg('path', { class: 'spark-area', d: area }), svg('path', { d: line }));
  return root;
}

function tile(
  label: string,
  value: number,
  sub?: string,
  href?: string,
  alert = false,
  trend?: { values: number[]; tone?: 'b' },
) {
  const inner = [
    h('span', { class: 'stat__label', text: label }),
    h('span', { class: 'stat__value', text: fmt(value) }),
    sub ? h('span', { class: 'stat__sub', text: sub }) : null,
    trend ? spark(trend.values) : null,
  ];
  const cls = `stat${alert ? ' stat--alert' : ''}${trend?.tone === 'b' ? ' stat--b' : ''}`;
  return h('li', {}, href ? h('a', { class: cls, href }, ...inner) : h('div', { class: cls }, ...inner));
}

const ICON = {
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
} as const;
const todoIcon = (name: keyof typeof ICON) => {
  const s = h('span', { class: 'todo__icon', 'aria-hidden': 'true' });
  s.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
  return s;
};

/** 待办队列：只列有真实计数的事项；数字为 0 的不进队列 */
export function todoItems(s: AdminStats) {
  const hidden = s.threadsHidden + s.repliesHidden + s.commentsHidden;
  return [
    {
      key: 'reports',
      icon: 'flag',
      title: '待处理举报',
      sub: '按时间先后处理',
      n: s.reportsOpen,
      href: '/admin/reports/',
      urgent: true,
    },
    {
      key: 'hidden',
      icon: 'eye',
      title: '已隐藏的内容',
      sub: '复核后恢复或删除',
      n: hidden,
      href: '/admin/content/?hidden=1',
      urgent: false,
    },
    {
      key: 'banned',
      icon: 'users',
      title: '封禁中的用户',
      sub: '到期会自动解除',
      n: s.banned,
      href: '/admin/users/?banned=1',
      urgent: false,
    },
  ].filter((t) => t.n > 0) as {
    key: string;
    icon: keyof typeof ICON;
    title: string;
    sub: string;
    n: number;
    href: string;
    urgent: boolean;
  }[];
}

function renderTodo(s: AdminStats) {
  if (!todoEl) return;
  todoEl.removeAttribute('aria-busy');
  const items = todoItems(s);
  const rows = items.map((t) =>
    h(
      'li',
      {},
      h(
        'a',
        { href: t.href, 'data-urgent': t.urgent ? '' : undefined },
        todoIcon(t.icon),
        h('span', { class: 'todo__text' }, h('span', { text: t.title }), h('small', { text: t.sub })),
        h('span', { class: 'todo__n', text: fmt(t.n) }),
      ),
    ),
  );
  // 留言 / 友链审核没有汇总计数：给入口，不写数字
  rows.push(
    h(
      'li',
      {},
      h(
        'a',
        { href: '/admin/guestbook/' },
        todoIcon('message'),
        h(
          'span',
          { class: 'todo__text' },
          h('span', { text: '留言审核' }),
          h('small', { text: '打开队列查看待审核' }),
        ),
        h('span', { class: 'todo__n todo__n--go', text: '去审核' }),
      ),
    ),
  );
  todoEl.replaceChildren(
    ...(items.length
      ? []
      : [
          h(
            'li',
            { class: 'todo__item' },
            h('span', { class: 'muted', text: '举报、隐藏内容与封禁都已处理完。' }),
          ),
        ]),
    ...rows,
  );
}

function bar(value: number, max: number, cls: string) {
  const root = svg('svg', {
    viewBox: '0 0 100 8',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  root.append(
    svg('rect', { x: 0, y: 0, height: 8, width: max ? ((value / max) * 100).toFixed(2) : 0, rx: 4 }),
  );
  return h('div', { class: `mix__bar ${cls}` }, root);
}

function renderMix(s: AdminStats) {
  if (!mixEl) return;
  mixEl.removeAttribute('aria-busy');
  const rows = [
    { label: '主题', total: s.threads, hidden: s.threadsHidden, cls: '' },
    { label: '回复', total: s.replies, hidden: s.repliesHidden, cls: 'mix__bar--app' },
    { label: '评论', total: s.comments, hidden: s.commentsHidden, cls: 'mix__bar--ai' },
  ];
  const max = Math.max(...rows.map((r) => r.total));
  if (!max) {
    mixEl.replaceChildren(h('li', { class: 'muted', text: '社区还没有内容。' }));
    return;
  }
  mixEl.replaceChildren(
    ...rows.map((r) =>
      h(
        'li',
        {},
        h(
          'span',
          { class: 'mix__row' },
          h('span', { text: r.label }),
          h('span', {
            class: 'muted',
            text: `${fmt(r.total)}${r.hidden ? `（隐藏 ${fmt(r.hidden)}）` : ''}`,
          }),
        ),
        bar(r.total, max, r.cls),
      ),
    ),
  );
}

function chart(s: AdminStats) {
  const W = 600;
  const H = 160;
  const days = s.daily;
  const { bars, max } = groupedBars(
    [
      { key: 'signups', values: days.map((d) => d.signups) },
      { key: 'posts', values: days.map((d) => d.posts) },
    ],
    { width: W, height: H, gap: 4 },
  );
  const root = svg('svg', {
    class: 'chart',
    viewBox: `0 -12 ${W} ${H + 32}`,
    role: 'img',
    'aria-label': `近 30 天每日新注册与发帖数柱状图，最高刻度 ${max}。共新注册 ${s.signups30} 人。`,
  });
  root.append(svg('line', { class: 'chart__axis', x1: 0, x2: W, y1: H, y2: H }));
  root.append(svg('line', { class: 'chart__axis', x1: 0, x2: W, y1: 0, y2: 0, 'stroke-dasharray': '3 3' }));
  const top = svg('text', { class: 'chart__label', x: 0, y: -2 });
  top.textContent = String(max);
  root.append(top);
  for (const b of bars) {
    if (!b.height) continue;
    const r = svg('rect', {
      class: `chart__bar--${b.series === 'signups' ? 'a' : 'b'}`,
      x: b.x.toFixed(1),
      y: b.y.toFixed(1),
      width: b.width.toFixed(1),
      height: b.height.toFixed(1),
      rx: 1.5,
    });
    const t = svg('title', {});
    t.textContent = `${days[b.index].day} ${b.series === 'signups' ? '新注册' : '发帖'} ${b.value}`;
    r.append(t);
    root.append(r);
  }
  for (const i of [0, 9, 19, 29]) {
    if (!days[i]) continue;
    const t = svg('text', {
      class: 'chart__label',
      x: (i + 0.5) * (W / days.length),
      y: H + 16,
      'text-anchor': 'middle',
    });
    t.textContent = days[i].day.slice(5);
    root.append(t);
  }
  chartEl.replaceChildren(root);
  tableEl.replaceChildren(
    h(
      'table',
      { class: 'data-table' },
      h('caption', { class: 'visually-hidden', text: '近 30 天每日数据' }),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col', text: '日期' }),
          h('th', { scope: 'col', class: 'num', text: '新注册' }),
          h('th', { scope: 'col', class: 'num', text: '发帖' }),
        ),
      ),
      h(
        'tbody',
        {},
        ...[...days]
          .reverse()
          .map((d) =>
            h(
              'tr',
              { class: 'no-check' },
              h('td', { 'data-label': '日期', text: d.day }),
              h('td', { class: 'num', 'data-label': '新注册', text: String(d.signups) }),
              h('td', { class: 'num', 'data-label': '发帖', text: String(d.posts) }),
            ),
          ),
      ),
    ),
  );
}

async function init() {
  const me = await initAdmin();
  if (!me) return;
  const repo = adminRepo();
  repo
    .liftExpiredBans()
    .then((n) => n && toast(`已解除 ${n} 个到期的封禁。`))
    .catch(() => {});
  try {
    const s = await repo.stats();
    statsEl.removeAttribute('aria-busy');
    statsEl.replaceChildren(
      tile('用户', s.users, `版主 ${s.moderators} · 管理员 ${s.admins}`, '/admin/users/', false, {
        values: s.daily.map((d) => d.signups),
      }),
      tile(
        '主题',
        s.threads,
        s.threadsHidden ? `${s.threadsHidden} 条已隐藏` : '全部可见',
        '/admin/content/?type=thread',
      ),
      tile(
        '回复',
        s.replies,
        s.repliesHidden ? `${s.repliesHidden} 条已隐藏` : '全部可见',
        '/admin/content/?type=reply',
      ),
      tile(
        '评论',
        s.comments,
        s.commentsHidden ? `${s.commentsHidden} 条已隐藏` : '全部可见',
        '/admin/content/?type=comment',
      ),
      tile(
        '待处理举报',
        s.reportsOpen,
        s.reportsOpen ? '点击处理' : '队列已清空',
        '/admin/reports/',
        s.reportsOpen > 0,
      ),
      tile('近 7 天注册', s.signups7, `近 30 天 ${s.signups30}`, undefined, false, {
        values: s.daily.slice(-7).map((d) => d.signups),
      }),
      tile(
        '近 30 天发帖',
        s.daily.reduce((n, d) => n + d.posts, 0),
        '主题 + 回复 + 评论',
        undefined,
        false,
        { values: s.daily.map((d) => d.posts), tone: 'b' },
      ),
      tile('封禁中', s.banned, '', '/admin/users/?banned=1'),
    );
    chart(s);
    renderTodo(s);
    renderMix(s);
    setStatusText(status, '');
  } catch (e) {
    todoEl?.removeAttribute('aria-busy');
    todoEl?.replaceChildren();
    mixEl?.removeAttribute('aria-busy');
    mixEl?.replaceChildren();
    statsEl.removeAttribute('aria-busy');
    statsEl.replaceChildren(
      h(
        'li',
        { class: 'stat-grid__state' },
        stateBlock('error', { text: errorText(e), retry: () => location.reload() }),
      ),
    );
    setStatusText(status, '');
  }
}

void init();
