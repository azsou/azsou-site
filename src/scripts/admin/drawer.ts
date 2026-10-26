/**
 * 记录详情抽屉（P10h T10.18）：右侧 <dialog>（showModal：焦点限制在抽屉内、Esc 关闭、关闭后焦点回到触发按钮），
 * 不跳页查看一条记录。用户抽屉 = 资料要点 + 活动时间线（封禁记录 + 管理员可见的审计记录，全部真实数据）
 * + 关联记录（该用户最近的主题 / 回复 / 评论）+ 打开完整档案。拿不到的部分（如版主读审计日志被拒）整块省略，不放占位。
 */
import type { AdminUser, AuditEntry, BanRecord, ContentType } from '@/lib/data';
import { auditLabel } from '@/lib/admin-nav';
import { contentHref } from '@/lib/data/admin';
import { url } from '@/lib/routes';
import { adminRepo, banText, dateTime, errorText, h, ROLE_LABEL } from './shell';
import { plainText, stateBlock } from './table';

let seq = 0;

export function openDrawer(title: string): { dlg: HTMLDialogElement; body: HTMLElement } {
  const id = `drawer-${++seq}`;
  const close = h('button', { type: 'button', class: 'btn btn--icon btn--sm', 'aria-label': '关闭' });
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const body = h('div', { class: 'drawer__body', 'aria-busy': 'true' }, stateBlock('loading'));
  const dlg = h(
    'dialog',
    { class: 'drawer', 'aria-labelledby': id, 'data-drawer': true },
    h('header', { class: 'drawer__head' }, h('h2', { id, text: title }), close),
    body,
  ) as HTMLDialogElement;
  // 关闭时先播放退出动画（减少动态效果时直接关闭）
  const shut = () => {
    if (dlg.dataset.closing !== undefined) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return dlg.close();
    dlg.dataset.closing = '';
    const done = (e?: AnimationEvent) => {
      if (e && e.target !== dlg) return;
      if (dlg.open) dlg.close();
    };
    dlg.addEventListener('animationend', done);
    setTimeout(done, 320);
  };
  close.addEventListener('click', shut);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    shut();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) shut();
  });
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  document.body.append(dlg);
  dlg.showModal();
  close.focus();
  return { dlg, body };
}

const section = (title: string, ...kids: (Node | null)[]) =>
  h('section', { class: 'drawer__section' }, h('h3', { text: title }), ...kids);

const fact = (k: string, v: string) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }));

type Event = { at: string; title: string; detail?: string };

export function timelineEvents(u: AdminUser, bans: BanRecord[], audit: AuditEntry[]): Event[] {
  const ev: Event[] = [{ at: u.createdAt, title: '注册账号' }];
  for (const b of bans) {
    ev.push({ at: b.createdAt, title: b.expiresAt ? '被封禁（有期限）' : '被永久封禁', detail: b.reason });
    if (b.liftedAt) ev.push({ at: b.liftedAt, title: '解除封禁', detail: b.liftReason });
  }
  for (const a of audit) {
    // 封禁 / 解封已由 bans 表示，审计里同类记录不重复
    if (/^user\.(ban|unban)$/.test(a.action)) continue;
    ev.push({ at: a.createdAt, title: auditLabel(a.action) });
  }
  return ev.filter((e) => !!e.at).sort((a, b) => b.at.localeCompare(a.at));
}

export async function openUserDrawer(id: string, isAdmin: boolean) {
  const { body } = openDrawer('用户详情');
  const repo = adminRepo();
  try {
    const u = await repo.getUser(id);
    if (!u) {
      body.removeAttribute('aria-busy');
      body.replaceChildren(stateBlock('empty', { title: '没有找到这个用户', text: '可能已注销。' }));
      return;
    }
    const kinds: [ContentType, string][] = [
      ['thread', '主题'],
      ['reply', '回复'],
      ['comment', '评论'],
    ];
    const [bans, audit, ...lists] = await Promise.all([
      repo.bans(u.id).catch(() => [] as BanRecord[]),
      isAdmin
        ? repo
            .audit({ targetId: u.id, limit: 20 })
            .then((r) => r.items)
            .catch(() => [] as AuditEntry[])
        : Promise.resolve([] as AuditEntry[]),
      ...kinds.map(([t]) =>
        repo
          .listContent({ type: t, author: u.id, limit: 3 })
          .then((r) => r.items)
          .catch(() => []),
      ),
    ]);
    const related = lists
      .flatMap((items, i) => items.map((it) => ({ kind: kinds[i][1], it })))
      .sort((a, b) => b.it.createdAt.localeCompare(a.it.createdAt))
      .slice(0, 6);
    const events = timelineEvents(u, bans, audit).slice(0, 12);
    body.removeAttribute('aria-busy');
    const parts: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'profile__head' },
        h('span', { class: 'avatar avatar--lg', 'aria-hidden': 'true', text: [...u.displayName][0] ?? '?' }),
        h(
          'div',
          {},
          h('p', { class: 'card__title', 'data-drawer-name': true, text: u.displayName }),
          h(
            'p',
            { class: 'profile-meta' },
            h('span', { class: `badge${u.role === 'user' ? '' : ' badge--info'}`, text: ROLE_LABEL[u.role] }),
            u.banned
              ? h('span', { class: 'badge badge--danger', text: banText(u) })
              : h('span', { class: 'badge badge--ok', text: '正常' }),
          ),
          u.email ? h('p', { class: 'muted', text: u.email }) : null,
        ),
      ),
      section(
        '概况',
        h(
          'dl',
          { class: 'drawer__facts' },
          fact('主题', String(u.threads)),
          fact('回复', String(u.replies)),
          fact('评论', String(u.comments)),
          fact('被举报', String(u.reportsAgainst)),
        ),
      ),
      section(
        '活动时间线',
        h(
          'ol',
          { class: 'timeline', 'data-timeline': true },
          ...events.map((e) =>
            h(
              'li',
              {},
              h('span', { text: e.title }),
              e.detail ? h('span', { class: 'muted', text: e.detail }) : null,
              h('time', { datetime: e.at, text: dateTime(e.at) }),
            ),
          ),
        ),
      ),
      related.length
        ? section(
            '关联记录',
            h(
              'ul',
              { class: 'related-list', role: 'list' },
              ...related.map(({ kind, it }) => {
                const href = contentHref(it.type, it.id, it.threadKey, it.pageKey);
                const text = `${kind}：${it.title || plainText(it.excerpt, 40)}`;
                return h('li', {}, href ? h('a', { href, text }) : h('span', { text }));
              }),
            ),
          )
        : null,
      h(
        'div',
        { class: 'btn-row' },
        h('a', { class: 'btn btn--primary btn--rect', href: url.adminUser(u.id), text: '打开完整档案' }),
      ),
    ];
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  } catch (e) {
    body.removeAttribute('aria-busy');
    body.replaceChildren(stateBlock('error', { text: errorText(e) }));
  }
}
