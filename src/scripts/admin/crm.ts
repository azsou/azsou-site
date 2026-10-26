/**
 * 后台 CRM 组件（P10 PR H）：
 *  - notesBlock：任意对象的内部备注（T10.18，0017 admin_notes）；
 *  - openContentDrawer：内容记录抽屉——要点、流程状态（草稿 / 待审 / 已发布 / 已下线 + 定时发布）、
 *    前台预览（与前台同一套 Markdown + 净化）、版本历史与行级对比、备注（T10.18 / T10.21）；
 *  - profilePanels：用户画像（T10.20）——分群、标签、订阅、近期发布、举报、登录记录；
 *  - emailDraftDialog：批量邮件草稿与预览（只预览 / 复制，**没有任何发送按钮或接口**）。
 * 拿不到的数据（旧库没有 0017、版主看不到订阅）整块省略或如实说明，不放假数据。
 */
import type { AdminUser, ContentRow, ContentType } from '@/lib/data';
import type {
  AdminNote,
  ContentVersion,
  NoteTarget,
  UserProfileExtra,
  WorkflowStatus,
} from '@/lib/data/admin';
import { diffStats, fillTemplate, lineDiff, recentCount, SEGMENT_LABEL, userSegments } from '@/lib/admin-crm';
import { markdownHtml } from '@/lib/sanitize';
import { confirmDialog, toast } from '../community/ui';
import { openDrawer } from './drawer';
import { adminRepo, dateTime, errorText, field, formDialog, h, ROLE_LABEL } from './shell';
import { plainText } from './table';

export const WF_LABEL: Record<WorkflowStatus, string> = {
  draft: '草稿',
  review: '待审',
  published: '已发布',
  offline: '已隐藏',
};
const WF_BADGE: Record<WorkflowStatus, string> = {
  draft: 'badge--muted',
  review: 'badge--info',
  published: 'badge--ok',
  offline: 'badge--danger',
};
export const wfBadge = (s: WorkflowStatus, at?: string | null) =>
  h('span', {
    class: `badge ${WF_BADGE[s]}`,
    'data-wf': s,
    text: at && s === 'review' ? `定时 ${dateTime(at)}` : WF_LABEL[s],
  });

const TYPE_LABEL: Record<ContentType, string> = { thread: '主题', reply: '回复', comment: '评论' };
const section = (title: string, ...kids: (Node | null)[]) =>
  h('section', { class: 'drawer__section' }, h('h3', { text: title }), ...kids);
const fact = (k: string, v: string | Node) => h('div', {}, h('dt', { text: k }), h('dd', {}, v));

// ---------------------------------------------------------------- 备注 ------
export function notesBlock(type: NoteTarget, id: string, meId: string | null, isAdmin: boolean): HTMLElement {
  const list = h('ul', { class: 'note-list', role: 'list', 'data-notes': true });
  const area = h('textarea', {
    class: 'input',
    rows: '3',
    maxlength: '2000',
    placeholder: '只有版主和管理员能看到，例如「已私信提醒，下次直接隐藏」',
    'aria-label': '新备注',
  }) as HTMLTextAreaElement;
  const add = h('button', { type: 'button', class: 'btn btn--sm btn--tonal btn--rect', text: '添加备注' });
  const wrap = h(
    'div',
    { class: 'notes' },
    list,
    h('div', { class: 'notes__form' }, area, h('div', { class: 'btn-row' }, add)),
  );
  const paint = (items: AdminNote[]) => {
    if (!items.length) {
      list.replaceChildren(h('li', { class: 'muted', text: '还没有备注。' }));
      return;
    }
    list.replaceChildren(
      ...items.map((n) => {
        const del =
          n.author === meId || isAdmin
            ? h('button', {
                type: 'button',
                class: 'btn btn--sm btn--ghost',
                text: '删除',
                'aria-label': '删除这条备注',
              })
            : null;
        del?.addEventListener('click', async () => {
          if (!(await confirmDialog('删除这条备注？', '删除'))) return;
          try {
            await adminRepo().deleteNote(n.id);
            toast('已删除备注。');
            await load();
          } catch (e) {
            toast(errorText(e, '删除失败'), 'error');
          }
        });
        return h(
          'li',
          { class: 'note' },
          h('p', { class: 'note__body', text: n.body }),
          h(
            'p',
            { class: 'note__meta' },
            h('time', { datetime: n.createdAt, text: dateTime(n.createdAt) }),
            del,
          ),
        );
      }),
    );
  };
  const load = async () => {
    try {
      paint(await adminRepo().notes(type, id));
    } catch {
      wrap.replaceChildren(h('p', { class: 'muted', text: '备注功能需要数据库迁移 0017。' }));
    }
  };
  add.addEventListener('click', async () => {
    const text = area.value.trim();
    if (!text) return area.focus();
    add.disabled = true;
    try {
      await adminRepo().addNote(type, id, text);
      area.value = '';
      toast('已添加备注。');
      await load();
    } catch (e) {
      toast(errorText(e, '保存失败'), 'error');
    } finally {
      add.disabled = false;
    }
  });
  void load();
  return wrap;
}

// ------------------------------------------------------------ 版本对比 ------
export function diffView(before: string, after: string): HTMLElement {
  const ops = lineDiff(before, after);
  const s = diffStats(ops);
  return h(
    'div',
    { class: 'diff' },
    h(
      'p',
      { class: 'diff__stats' },
      h('span', { class: 'diff__add', text: `+${s.add}` }),
      h('span', { class: 'diff__del', text: `−${s.del}` }),
    ),
    h(
      'pre',
      { class: 'diff__body', tabindex: '0', 'aria-label': '版本差异' },
      ...ops.map((o) =>
        h('span', {
          class: `diff__line diff__line--${o.op}`,
          text: `${o.op === 'add' ? '+ ' : o.op === 'del' ? '− ' : '  '}${o.text}\n`,
        }),
      ),
    ),
  );
}

function versionsBlock(current: { title: string; body: string }, versions: ContentVersion[]): HTMLElement {
  if (!versions.length) return h('p', { class: 'muted', text: '没有历史版本（发布后未被修改过）。' });
  const out = h('div', { class: 'versions' });
  const pick = h('select', { 'aria-label': '对比的历史版本', class: 'input' });
  versions.forEach((v, i) =>
    pick.append(
      h('option', { value: String(i), text: `${dateTime(v.createdAt)}${i === 0 ? '（上一版）' : ''}` }),
    ),
  );
  const view = h('div', {});
  const paint = () => {
    const v = versions[Number(pick.value) || 0];
    const before = `${v.title ? `# ${v.title}\n\n` : ''}${v.body}`;
    const after = `${current.title && v.title !== null ? `# ${current.title}\n\n` : ''}${current.body}`;
    view.replaceChildren(diffView(before, after));
  };
  pick.addEventListener('change', paint);
  out.append(field('与当前版本对比', pick), view);
  paint();
  return out;
}

// ------------------------------------------------------------ 内容抽屉 ------
function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function openContentDrawer(
  r: ContentRow,
  opts: { meId: string | null; isAdmin: boolean; onChange?: () => void },
) {
  const { body } = openDrawer(`${TYPE_LABEL[r.type]}详情`);
  const repo = adminRepo();
  const [full, versions] = await Promise.all([
    repo.contentBody(r.type, r.id).catch(() => null),
    repo.versions(r.type, r.id).catch(() => null),
  ]);
  const text = full?.body ?? r.excerpt;
  body.removeAttribute('aria-busy');

  // 流程
  const status = h('select', { class: 'input', name: 'wf' }) as HTMLSelectElement;
  for (const s of ['draft', 'review', 'published', 'offline'] as WorkflowStatus[])
    status.append(h('option', { value: s, text: WF_LABEL[s], selected: s === r.wfStatus }));
  const when = h('input', {
    type: 'datetime-local',
    class: 'input',
    name: 'at',
    min: toLocalInput(new Date()),
    value: r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : '',
  }) as HTMLInputElement;
  const whenField = field('定时发布（可选）', when, '仅「待审」可定时；到点后由后台自动发布。');
  const syncWhen = () => (whenField.hidden = status.value !== 'review');
  status.addEventListener('change', syncWhen);
  syncWhen();
  const save = h('button', { type: 'button', class: 'btn btn--sm btn--primary btn--rect', text: '更新状态' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const s = status.value as WorkflowStatus;
      const at = s === 'review' && when.value ? new Date(when.value).toISOString() : null;
      if (at && Date.parse(at) <= Date.now()) throw new Error('定时时间需要晚于现在');
      await repo.setWorkflow(r.type, [r.id], s, at);
      toast(at ? `已设为定时发布：${dateTime(at)}` : `已改为「${WF_LABEL[s]}」。`);
      opts.onChange?.();
    } catch (e) {
      toast(errorText(e, '更新失败'), 'error');
    } finally {
      save.disabled = false;
    }
  });

  const preview = h('div', { class: 'prose prose--sm drawer__preview', 'data-preview-body': true });
  preview.innerHTML = markdownHtml(text || '（空）');

  body.replaceChildren(
    h(
      'div',
      { class: 'record-head' },
      h('p', {
        class: 'card__title',
        text: r.type === 'thread' ? r.title : plainText(r.excerpt, 60) || '（空）',
      }),
      h(
        'p',
        { class: 'profile-meta' },
        wfBadge(r.wfStatus, r.scheduledAt),
        r.openReports ? h('span', { class: 'badge badge--danger', text: `${r.openReports} 条举报` }) : null,
      ),
    ),
    section(
      '要点',
      h(
        'dl',
        { class: 'drawer__facts' },
        fact('作者', r.author.name),
        fact('发布于', dateTime(r.createdAt)),
        fact('最后编辑', r.editedAt ? dateTime(r.editedAt) : '—'),
        fact('历史版本', versions ? String(versions.length) : '—'),
      ),
    ),
    section(
      '发布流程',
      h('div', { class: 'wf-form' }, field('状态', status), whenField, h('div', { class: 'btn-row' }, save)),
    ),
    section(
      '前台预览',
      preview,
      r.href
        ? h('a', {
            class: 'btn btn--sm btn--outline btn--rect',
            href: r.href,
            target: '_blank',
            rel: 'noopener',
            text: '在前台打开',
          })
        : null,
    ),
    ...(versions ? [section('版本对比', versionsBlock({ title: r.title, body: text }, versions))] : []),
    section('内部备注', notesBlock(r.type, r.id, opts.meId, opts.isAdmin)),
  );
}

// ------------------------------------------------------------ 用户画像 ------
export function profilePanels(
  u: AdminUser,
  p: UserProfileExtra | null,
  panel: (title: string, ...kids: (Node | string | null)[]) => HTMLElement,
  ctx: { meId: string | null; isAdmin: boolean },
): HTMLElement[] {
  if (!p) return [panel('用户画像', h('p', { class: 'muted', text: '画像需要数据库迁移 0017。' }))];
  const segs = userSegments({ ...u, recentPosts: recentCount(p.posts) });
  const tagList = h('div', { class: 'tag-row', 'data-tags': true });
  const paintTags = () =>
    tagList.replaceChildren(
      ...(p.tags.length ? p.tags : []).map((t) => {
        const x = h(
          'button',
          { type: 'button', class: 'chip chip--removable', 'aria-label': `移除标签：${t}` },
          t,
          h('span', { 'aria-hidden': 'true', text: '×' }),
        );
        x.addEventListener('click', async () => {
          try {
            await adminRepo().removeTag(u.id, t);
            p.tags = p.tags.filter((y) => y !== t);
            paintTags();
          } catch (e) {
            toast(errorText(e, '移除失败'), 'error');
          }
        });
        return x;
      }),
      p.tags.length ? '' : h('span', { class: 'muted', text: '暂无标签' }),
    );
  paintTags();
  const tagInput = h('input', {
    type: 'text',
    class: 'input',
    maxlength: '24',
    placeholder: '新标签，如「种子用户」',
    'aria-label': '新标签',
  }) as HTMLInputElement;
  const tagAdd = h('button', { type: 'button', class: 'btn btn--sm btn--tonal btn--rect', text: '添加' });
  const addTag = async () => {
    const t = tagInput.value.trim();
    if (!t) return tagInput.focus();
    try {
      await adminRepo().addTag(u.id, t);
      if (!p.tags.includes(t)) p.tags.push(t);
      tagInput.value = '';
      paintTags();
    } catch (e) {
      toast(errorText(e, '添加失败'), 'error');
    }
  };
  tagAdd.addEventListener('click', () => void addTag());
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addTag();
    }
  });

  const kindLabel: Record<string, string> = {
    thread: '主题',
    reply: '回复',
    comment: '评论',
    profile: '资料',
  };
  const reportList = (items: UserProfileExtra['reportsFiled']) =>
    items.length
      ? h(
          'ul',
          { class: 'related-list', role: 'list' },
          ...items.map((x) =>
            h(
              'li',
              {},
              h('span', { text: `${kindLabel[x.targetType] ?? x.targetType} · ${x.reason}` }),
              h('span', {
                class: `badge${x.status === 'open' ? ' badge--danger' : ''}`,
                text: x.status === 'open' ? '待处理' : x.status === 'resolved' ? '已处理' : '已驳回',
              }),
              h('time', { datetime: x.createdAt, text: dateTime(x.createdAt) }),
            ),
          ),
        )
      : h('p', { class: 'muted', text: '没有记录。' });

  return [
    panel(
      '分群与标签',
      h(
        'p',
        { class: 'tag-row' },
        ...(segs.length
          ? segs.map((s) =>
              h('span', { class: 'badge badge--accent', 'data-segment': s, text: SEGMENT_LABEL[s] }),
            )
          : [h('span', { class: 'muted', text: '不属于任何分群' })]),
      ),
      tagList,
      h('div', { class: 'inline-form' }, tagInput, tagAdd),
    ),
    panel(
      '订阅与登录',
      h(
        'dl',
        { class: 'drawer__facts' },
        fact(
          '邮件订阅',
          !p.subscriptionVisible
            ? '仅管理员可见'
            : p.subscription
              ? `${p.subscription.status === 'confirmed' ? '已订阅' : p.subscription.status === 'pending' ? '待确认' : '已退订'}（${p.subscription.lang}）`
              : '未订阅',
        ),
        fact('邮箱验证', p.emailConfirmedAt ? dateTime(p.emailConfirmedAt) : '—'),
        fact('最近登录', p.lastSignInAt ? dateTime(p.lastSignInAt) : '—'),
        fact('登录记录', String(p.logins.length)),
      ),
      p.logins.length
        ? h(
            'ul',
            { class: 'related-list', role: 'list', 'data-logins': true },
            ...p.logins.slice(0, 8).map((l) =>
              h(
                'li',
                {},
                h('time', { datetime: l.createdAt, text: dateTime(l.createdAt) }),
                h('span', {
                  class: 'muted',
                  text:
                    [l.ip, l.userAgent ? plainText(l.userAgent, 48) : ''].filter(Boolean).join(' · ') || '—',
                }),
              ),
            ),
          )
        : h('p', { class: 'muted', text: '没有登录会话记录（数据来自认证服务的会话表）。' }),
    ),
    panel(
      '近期发布',
      p.posts.length
        ? h(
            'ul',
            { class: 'related-list', role: 'list', 'data-posts': true },
            ...p.posts.slice(0, 10).map((x) =>
              h(
                'li',
                {},
                h('span', {
                  text: `${kindLabel[x.kind]}：${x.title || plainText(x.excerpt, 40) || '（空）'}`,
                }),
                x.published ? null : h('span', { class: 'badge badge--danger', text: '已隐藏' }),
                h('time', { datetime: x.createdAt, text: dateTime(x.createdAt) }),
              ),
            ),
          )
        : h('p', { class: 'muted', text: '还没有发布内容。' }),
    ),
    panel('TA 发起的举报', reportList(p.reportsFiled)),
    panel('TA 收到的举报', reportList(p.reportsAgainst)),
    panel('内部备注', notesBlock('profile', u.id, ctx.meId, ctx.isAdmin)),
  ];
}

// -------------------------------------------------------- 批量邮件草稿 ------
export function emailDraftDialog(users: AdminUser[]) {
  const subject = h('input', {
    type: 'text',
    class: 'input',
    name: 'subject',
    maxlength: '120',
    value: 'AZ Studio 社区通知',
  }) as HTMLInputElement;
  const text = h('textarea', {
    class: 'input',
    name: 'body',
    rows: '6',
    maxlength: '4000',
  }) as HTMLTextAreaElement;
  text.value = '{{name}}，你好：\n\n感谢你参与 AZ Studio 社区。\n\n—— AZ Studio';
  const withMail = users.filter((u) => !!u.email);
  const pv = h('div', { class: 'mail-preview', 'aria-live': 'polite' });
  const paint = () => {
    const u = withMail[0] ?? users[0];
    const vars = u
      ? { name: u.displayName, role: ROLE_LABEL[u.role] ?? u.role }
      : { name: '（示例）', role: '用户' };
    pv.replaceChildren(
      h('p', {
        class: 'mail-preview__meta',
        text: `收件人：${withMail.length} 位有邮箱的用户${users.length > withMail.length ? `（另 ${users.length - withMail.length} 位邮箱不可见，已排除）` : ''}`,
      }),
      h('p', { class: 'mail-preview__subject', text: fillTemplate(subject.value, vars) }),
      h('pre', { class: 'mail-preview__body', text: fillTemplate(text.value, vars) }),
    );
  };
  subject.addEventListener('input', paint);
  text.addEventListener('input', paint);
  paint();
  void formDialog({
    title: '批量邮件草稿（仅预览）',
    body: [
      h('p', {
        class: 'notice',
        text: '后台不会发送任何邮件：这里只生成草稿与预览，可复制到你的邮件服务里人工发送。可用变量 {{name}}、{{role}}。',
      }),
      field('主题', subject),
      field('正文', text),
      pv,
    ],
    submit: '复制草稿',
    run: async () => {
      const list = withMail.map((u) => u.email).join(', ');
      await navigator.clipboard
        ?.writeText(`收件人：${list}\n主题：${subject.value}\n\n${text.value}`)
        .catch(() => undefined);
      toast('已复制草稿（未发送）。');
    },
  });
}

export const segmentOf = (u: AdminUser) => userSegments(u);
