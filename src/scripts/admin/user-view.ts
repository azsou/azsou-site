/** /admin/users/view/?id=：资料、角色（管理员）、封禁 / 解封 / 警告（版主）、封禁记录、发布的内容。 */
import type { AdminUser, BanRecord, ContentType, Profile, Role } from '@/lib/data';
import { url } from '@/lib/routes';
import { toast } from '../community/ui';
import {
  adminRepo,
  banText,
  dateTime,
  errorText,
  field,
  formDialog,
  h,
  initAdmin,
  isAdminRole,
  ROLE_LABEL,
  select,
  setStatusText,
} from './shell';
import { BAN_DURATIONS, banExpiry } from '@/lib/admin-utils';
import { profilePanels } from './crm';

const box = document.querySelector<HTMLElement>('[data-user]')!;
const id = new URLSearchParams(location.search).get('id') ?? '';

function panel(title: string, ...children: (Node | string | null)[]) {
  const hid = `h-${title}`;
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': hid },
    h('h2', { id: hid, text: title }),
    ...children,
  );
}

function headPanel(u: AdminUser) {
  return h(
    'section',
    { class: 'panel', 'aria-label': '资料' },
    h(
      'div',
      { class: 'profile__head' },
      h('span', { class: 'avatar avatar--lg', 'aria-hidden': 'true', text: [...u.displayName][0] ?? '?' }),
      h(
        'div',
        {},
        h('h2', { class: 'card__title', 'data-name': true, text: u.displayName }),
        h(
          'p',
          { class: 'profile-meta' },
          h('span', {
            class: `badge${u.role === 'user' ? '' : ' badge--info'}`,
            'data-role': true,
            text: ROLE_LABEL[u.role],
          }),
          u.banned
            ? h('span', { class: 'badge badge--danger', 'data-ban-state': true, text: banText(u) })
            : h('span', { class: 'badge badge--ok', 'data-ban-state': true, text: '正常' }),
          h('span', { class: 'muted', text: `注册于 ${dateTime(u.createdAt)}` }),
        ),
      ),
    ),
    h(
      'dl',
      { class: 'kv' },
      h('dt', { text: '用户 ID' }),
      h('dd', {}, h('code', { text: u.id })),
      u.email ? h('dt', { text: '邮箱' }) : null,
      u.email ? h('dd', { text: u.email }) : null,
      h('dt', { text: '发布' }),
      h('dd', { text: `主题 ${u.threads} · 回复 ${u.replies} · 评论 ${u.comments}` }),
      h('dt', { text: '待处理举报' }),
      h('dd', { text: String(u.reportsAgainst) }),
      u.banned && u.banReason ? h('dt', { text: '封禁原因' }) : null,
      u.banned && u.banReason ? h('dd', { text: u.banReason }) : null,
    ),
    h(
      'div',
      { class: 'btn-row mt-4' },
      h('a', { class: 'btn btn--sm', href: url.user(u.id), text: '公开主页' }),
      h('a', {
        class: 'btn btn--sm',
        href: `/admin/content/?author=${encodeURIComponent(u.id)}`,
        text: '他的主题',
      }),
      h('a', {
        class: 'btn btn--sm',
        href: `/admin/content/?type=reply&author=${encodeURIComponent(u.id)}`,
        text: '他的回复',
      }),
      h('a', {
        class: 'btn btn--sm',
        href: `/admin/content/?type=comment&author=${encodeURIComponent(u.id)}`,
        text: '他的评论',
      }),
    ),
  );
}

function rolePanel(u: AdminUser, me: Profile) {
  if (!isAdminRole(me))
    return panel(
      '角色',
      h('p', { class: 'muted', text: `当前角色：${ROLE_LABEL[u.role]}。只有管理员可以修改角色。` }),
    );
  const self = u.id === me.id;
  const s = select(
    'role',
    (['user', 'moderator', 'admin'] as Role[]).map((r) => [r, ROLE_LABEL[r]]),
    u.role,
  );
  s.disabled = self;
  const save = h('button', { type: 'button', class: 'btn btn--primary', text: '保存角色', disabled: self });
  save.addEventListener('click', async () => {
    if (s.value === u.role) return toast('角色没有变化。');
    save.disabled = true;
    try {
      await adminRepo().setRole(u.id, s.value as Role, u.banned);
      toast(`已把 ${u.displayName} 的角色改为 ${ROLE_LABEL[s.value]}。`);
      await load(me);
    } catch (e) {
      toast(errorText(e, '修改失败'), 'error');
      save.disabled = false;
    }
  });
  return panel(
    '角色',
    h(
      'div',
      { class: 'toolbar' },
      field(
        '角色',
        s,
        self
          ? '不能修改自己的角色（防止锁死后台）。'
          : '版主：处理论坛与评论；管理员：另有站点设置、审计与角色管理。',
      ),
      save,
    ),
  );
}

function banPanel(u: AdminUser, me: Profile) {
  const self = u.id === me.id;
  const protectedTarget = u.role !== 'user' && !isAdminRole(me);
  if (self) return panel('封禁', h('p', { class: 'muted', text: '不能封禁自己。' }));
  if (protectedTarget)
    return panel('封禁', h('p', { class: 'muted', text: '只有管理员可以封禁或解封版主 / 管理员。' }));
  if (u.banned) {
    const un = h('button', { type: 'button', class: 'btn btn--primary', text: '解除封禁' });
    un.addEventListener('click', async () => {
      const reason = h('textarea', { name: 'reason', maxlength: '500', rows: '3' });
      const ok = await formDialog({
        title: `解除 ${u.displayName} 的封禁`,
        body: [field('解封说明（选填，写入审计日志）', reason)],
        submit: '解除封禁',
        run: () => adminRepo().unban(u.id, reason.value),
      });
      if (ok) {
        toast('已解除封禁。');
        await load(me);
      }
    });
    return panel(
      '封禁',
      h('p', { text: `${banText(u)}。${u.banReason ? `原因：${u.banReason}` : ''}` }),
      h('div', { class: 'btn-row' }, un),
    );
  }
  const reason = h('textarea', { name: 'reason', maxlength: '500', rows: '3' });
  const dur = select('duration', BAN_DURATIONS, '7');
  const custom = h('input', { type: 'datetime-local', name: 'until' });
  const customField = field('到期时间', custom);
  customField.hidden = true;
  dur.addEventListener('change', () => (customField.hidden = dur.value !== 'custom'));
  const err = h('p', { class: 'field__error', role: 'alert' });
  const go = h('button', { type: 'button', class: 'btn btn--danger', text: '封禁' });
  go.addEventListener('click', async () => {
    const exp = banExpiry(dur.value, custom.value);
    if (exp instanceof Error) {
      err.textContent = exp.message;
      return;
    }
    if ([...reason.value.trim()].length > 500) {
      err.textContent = '原因最多 500 字。';
      return;
    }
    err.textContent = '';
    go.disabled = true;
    try {
      await adminRepo().ban(u.id, reason.value, exp);
      toast(`已封禁 ${u.displayName}。`);
      await load(me);
    } catch (e) {
      err.textContent = errorText(e, '封禁失败');
      go.disabled = false;
    }
  });
  return panel(
    '封禁',
    h(
      'div',
      { class: 'form' },
      field('原因', reason, '会通过站内通知告诉对方，并写入审计日志（最多 500 字）。'),
      field('时长', dur),
      customField,
      err,
      h('div', { class: 'btn-row' }, go),
    ),
  );
}

function warnPanel(u: AdminUser, me: Profile) {
  if (u.id === me.id) return null;
  const msg = h('textarea', { name: 'message', maxlength: '190', rows: '2' });
  const send = h('button', { type: 'button', class: 'btn', text: '发送警告' });
  const err = h('p', { class: 'field__error', role: 'alert' });
  send.addEventListener('click', async () => {
    if (!msg.value.trim()) {
      err.textContent = '请填写提醒内容。';
      return;
    }
    err.textContent = '';
    send.disabled = true;
    try {
      await adminRepo().warn(u.id, msg.value);
      msg.value = '';
      toast('警告已发送。');
    } catch (e) {
      err.textContent = errorText(e, '发送失败');
    } finally {
      send.disabled = false;
    }
  });
  return panel(
    '警告',
    h(
      'div',
      { class: 'form' },
      field('提醒内容', msg, '以「版主提醒」站内通知发给对方（最多 190 字）。'),
      err,
      h('div', { class: 'btn-row' }, send),
    ),
  );
}

function bansPanel(bans: BanRecord[], names: Record<string, string>) {
  if (!bans.length) return panel('封禁记录', h('p', { class: 'muted', text: '没有封禁记录。' }));
  const who = (id: string | null) => (id ? (names[id] ?? id.slice(0, 8)) : '系统');
  return panel(
    '封禁记录',
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data-table' },
        h('caption', { class: 'visually-hidden', text: '封禁记录' }),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['时间', '操作人', '原因', '到期', '解除'].map((t) => h('th', { scope: 'col', text: t })),
          ),
        ),
        h(
          'tbody',
          {},
          ...bans.map((b) =>
            h(
              'tr',
              { class: 'no-check' },
              h('td', { class: 'nowrap', 'data-label': '时间', text: dateTime(b.createdAt) }),
              h('td', { 'data-label': '操作人', text: who(b.createdBy) }),
              h('td', { 'data-label': '原因', text: b.reason || '—' }),
              h('td', { 'data-label': '到期', text: b.expiresAt ? dateTime(b.expiresAt) : '永久' }),
              h('td', {
                'data-label': '解除',
                text: b.liftedAt ? `${dateTime(b.liftedAt)} ${b.liftReason}`.trim() : '生效中',
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

async function contentPanel(u: AdminUser) {
  const repo = adminRepo();
  const kinds: [ContentType, string][] = [
    ['thread', '主题'],
    ['reply', '回复'],
    ['comment', '评论'],
  ];
  const lists = await Promise.all(kinds.map(([t]) => repo.listContent({ type: t, author: u.id, limit: 5 })));
  return panel(
    '最近发布',
    h(
      'div',
      { class: 'split-2' },
      ...kinds.map(([t, label], i) =>
        h(
          'div',
          {},
          h('h3', { class: 'list-heading', text: `${label}（${lists[i].total}）` }),
          lists[i].items.length
            ? h(
                'ul',
                { class: 'list-group', role: 'list' },
                ...lists[i].items.map((r) =>
                  h(
                    'li',
                    {},
                    h(
                      r.href ? 'a' : 'span',
                      { class: 'list-row', ...(r.href ? { href: r.href } : {}) },
                      h(
                        'span',
                        { class: 'list-row__main' },
                        h('span', {
                          class: 'list-row__title',
                          text: (t === 'thread' ? r.title : r.excerpt).slice(0, 60) || '（空）',
                        }),
                        h('span', {
                          class: 'list-row__sub',
                          text: `${dateTime(r.createdAt)}${r.published ? '' : ' · 已隐藏'}`,
                        }),
                      ),
                    ),
                  ),
                ),
              )
            : h('p', { class: 'muted', text: '暂无。' }),
        ),
      ),
    ),
  );
}

async function load(me: Profile) {
  box.setAttribute('aria-busy', 'true');
  try {
    const repo = adminRepo();
    const u = await repo.getUser(id);
    if (!u) {
      box.replaceChildren(h('p', { class: 'notice notice--error', role: 'alert', text: '找不到这个用户。' }));
      return;
    }
    document.title = `${u.displayName} · 用户详情 · 管理后台 · AZ Studio`;
    const bans = await repo.bans(u.id);
    const names = await repo.names(
      bans.flatMap((b) => [b.createdBy ?? '', b.liftedBy ?? '']).filter(Boolean),
    );
    const parts: (Node | null)[] = [
      headPanel(u),
      rolePanel(u, me),
      banPanel(u, me),
      warnPanel(u, me),
      bansPanel(bans, names),
    ];
    box.replaceChildren(...parts.filter((x): x is Node => !!x));
    box.append(await contentPanel(u));
    const extra = await repo.userProfile(u.id).catch(() => null);
    box.append(...profilePanels(u, extra, panel, { meId: me.id, isAdmin: isAdminRole(me) }));
  } catch (e) {
    box.replaceChildren(h('p', { class: 'data-status', role: 'status' }));
    setStatusText(box.querySelector('p'), errorText(e), 'error');
  } finally {
    box.removeAttribute('aria-busy');
  }
}

void initAdmin().then((me) => me && load(me));
