/**
 * /admin/guestbook/（版主 + 管理员）与 /admin/links/（仅管理员）：待审核队列（T7.3 / T7.4）。
 * 通过 / 拒绝 / 退回待审核 / 删除，都经数据库 RPC（0015，入口先校验角色并写审计）。
 */
import { getGuestbook, type FriendLink, type GuestbookEntry, type ModStatus } from '@/lib/data/guestbook';
import { confirmDialog, toast } from '../community/ui';
import { dateTime, errorText, h, initAdmin, readParams, setStatusText, writeParams } from './shell';
import { stateBlock } from './table';

const list = document.querySelector<HTMLElement>('[data-mod-list]')!;
const kind = list.dataset.kind === 'links' ? 'links' : 'guestbook';
const status = document.querySelector<HTMLElement>('[data-status]');
const more = document.querySelector<HTMLButtonElement>('[data-more]')!;
const btns = [...document.querySelectorAll<HTMLButtonElement>('[data-status-filter] button')];
const DEFAULTS = { status: 'pending' };
const state = readParams(DEFAULTS);
const LIMIT = 30;
let offset = 0;
const api = getGuestbook();
const LABEL: Record<ModStatus, [string, string]> = {
  pending: ['待审核', 'badge--warn'],
  approved: ['已通过', 'badge--ok'],
  rejected: ['已拒绝', 'badge--muted'],
};
const filter = () =>
  (['pending', 'approved', 'rejected', 'all'].includes(state.status) ? state.status : 'pending') as
    ModStatus | 'all';

function actions(id: string, cur: ModStatus, title: string) {
  const row = h('div', { class: 'btn-row mod-item__actions' });
  const act = (label: string, next: ModStatus | 'delete', primary = false) => {
    const b = h('button', {
      class: `btn btn--sm${primary ? ' btn--primary' : ''}${next === 'delete' ? ' btn--danger' : ''}`,
      type: 'button',
      text: label,
      'aria-label': `${label}：${title}`,
    }) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      if (next === 'delete' && !(await confirmDialog(`永久删除「${title}」？此操作不可撤销。`, '删除')))
        return;
      b.disabled = true;
      try {
        if (kind === 'guestbook') {
          if (next === 'delete') await api.modDeleteEntries([id]);
          else await api.modSetEntries([id], next);
        } else if (next === 'delete') await api.adminDeleteLinks([id]);
        else await api.adminSetLinks([id], next);
        toast(next === 'delete' ? '已删除' : `已设为「${LABEL[next][0]}」`);
        void reload();
      } catch (e) {
        b.disabled = false;
        toast(errorText(e, '操作失败'), 'error');
      }
    });
    row.append(b);
  };
  if (cur !== 'approved') act('通过', 'approved', true);
  if (cur !== 'rejected') act('拒绝', 'rejected');
  if (cur !== 'pending') act('退回待审核', 'pending');
  act('删除', 'delete');
  return row;
}

function entryCard(e: GuestbookEntry) {
  const [txt, cls] = LABEL[e.status];
  return h(
    'li',
    { class: 'report mod-item' },
    h(
      'div',
      {},
      h(
        'p',
        { class: 'report__head' },
        h('span', { class: `badge ${cls}`, text: txt }),
        h('strong', { text: e.nickname }),
        h('span', { text: dateTime(e.createdAt) }),
      ),
      h('p', { class: 'mod-item__body', text: e.body }),
      actions(e.id, e.status, e.nickname),
    ),
  );
}

function linkCard(l: FriendLink) {
  const [txt, cls] = LABEL[l.status];
  return h(
    'li',
    { class: 'report mod-item' },
    h(
      'div',
      {},
      h(
        'p',
        { class: 'report__head' },
        h('span', { class: `badge ${cls}`, text: txt }),
        h('strong', { text: l.name }),
        h('span', { text: dateTime(l.createdAt) }),
      ),
      h(
        'p',
        { class: 'mod-item__body' },
        h('a', { href: l.url, rel: 'noopener noreferrer nofollow', text: l.url }),
      ),
      l.description ? h('p', { class: 'mod-item__body', text: l.description }) : '',
      h('p', { class: 'report__head', text: `联系方式：${l.contact || '（未填写）'}` }),
      actions(l.id, l.status, l.name),
    ),
  );
}

const stateLi = (el: HTMLElement) => h('li', { class: 'state-li' }, el);

async function load(append: boolean) {
  list.setAttribute('aria-busy', 'true');
  more.disabled = true;
  if (!append) list.replaceChildren(stateLi(stateBlock('loading')));
  const pendingOnly = filter() === 'pending';
  const noun = kind === 'guestbook' ? '留言' : '友链申请';
  const empty = () =>
    stateLi(
      stateBlock('empty', {
        title: pendingOnly ? `没有待审核的${noun}` : `没有符合条件的${noun}`,
        text: pendingOnly ? '新的提交会出现在这里。' : '切换上方的状态再看看。',
      }),
    );
  try {
    if (kind === 'guestbook') {
      const { items, total } = await api.modEntries(filter(), { offset, limit: LIMIT });
      if (!append) list.replaceChildren(...(items.length ? [] : [empty()]));
      list.append(...items.map(entryCard));
      offset += items.length;
      more.hidden = offset >= total;
      setStatusText(status, total ? `共 ${total} 条` : '');
    } else {
      const items = await api.adminLinks(filter());
      list.replaceChildren(...(items.length ? items.map(linkCard) : [empty()]));
      more.hidden = true;
      setStatusText(status, items.length ? `共 ${items.length} 条` : '');
    }
  } catch (e) {
    if (!append)
      list.replaceChildren(stateLi(stateBlock('error', { text: errorText(e), retry: () => void reload() })));
    else setStatusText(status, errorText(e), 'error');
  } finally {
    list.removeAttribute('aria-busy');
    more.disabled = false;
  }
}
function reload() {
  offset = 0;
  return load(false);
}

function syncButtons() {
  for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.value === filter()));
}
for (const b of btns)
  b.addEventListener('click', () => {
    state.status = b.dataset.value!;
    writeParams(state, DEFAULTS);
    syncButtons();
    void reload();
  });
more.addEventListener('click', () => void load(true));

void initAdmin().then((me) => {
  if (!me) return;
  syncButtons();
  void reload();
});
