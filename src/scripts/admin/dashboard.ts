/** /admin/：计数卡片 + 30 天柱状图（SVG，无图表库）+ 可访问的数据表；顺便清理到期封禁。 */
import type { AdminStats } from '@/lib/data';
import { groupedBars } from '@/lib/chart';
import { toast } from '../community/ui';
import { adminRepo, errorText, h, initAdmin, setStatusText } from './shell';

const statsEl = document.querySelector<HTMLElement>('[data-stats]')!;
const chartEl = document.querySelector<HTMLElement>('[data-chart]')!;
const tableEl = document.querySelector<HTMLElement>('[data-chart-table]')!;
const status = document.querySelector<HTMLElement>('[data-status]');

const fmt = (n: number) => n.toLocaleString('zh-CN');

function tile(label: string, value: number, sub?: string, href?: string, alert = false) {
  const inner = [
    h('span', { class: 'stat__label', text: label }),
    h('span', { class: 'stat__value', text: fmt(value) }),
    sub ? h('span', { class: 'stat__sub', text: sub }) : null,
  ];
  const cls = `stat${alert ? ' stat--alert' : ''}`;
  return h('li', {}, href ? h('a', { class: cls, href }, ...inner) : h('div', { class: cls }, ...inner));
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

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
      tile('用户', s.users, `版主 ${s.moderators} · 管理员 ${s.admins}`, '/admin/users/'),
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
      tile('近 7 天注册', s.signups7, `近 30 天 ${s.signups30}`),
      tile('封禁中', s.banned, '', '/admin/users/?banned=1'),
    );
    chart(s);
    setStatusText(status, '');
  } catch (e) {
    statsEl.removeAttribute('aria-busy');
    statsEl.replaceChildren();
    setStatusText(status, errorText(e), 'error');
  }
}

void init();
