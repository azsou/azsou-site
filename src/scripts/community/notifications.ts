/** /notifications/：通知列表、未读标记、全部已读；点击通知跳到对应主题 / 回复并标记已读。 */
import { getRepository, type Notification } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';
import { url } from '@/lib/routes';
import { setStatus } from '../render';
import { busy, h, timeEl, toastError, viewer } from './ui';

const root = document.querySelector<HTMLElement>('[data-notifications]')!;
const list = root.querySelector<HTMLElement>('[data-list]')!;
const tools = root.querySelector<HTMLElement>('[data-tools]')!;
const markAll = root.querySelector<HTMLButtonElement>('[data-mark-all]')!;

const KIND: Record<Notification['kind'], string> = {
  reply: '回复了你的主题',
  mention: '提到了你',
  like: '赞了你的内容',
  report: '举报处理结果',
  moderation: '版主操作',
  system: '系统消息',
};

export function notificationHref(n: Notification): string | null {
  if (n.threadKey) {
    const anchor = n.targetType === 'reply' && n.targetId ? `#r-${n.targetId}` : '';
    return url.forumThread(n.threadKey) + anchor;
  }
  if (n.targetType === 'thread' && n.targetId) return url.forumThread(n.targetId);
  return null;
}

/** 通知变化后同步顶栏未读角标 */
const announce = () => dispatchEvent(new CustomEvent('az:notifications'));

function row(n: Notification) {
  const href = notificationHref(n);
  const title = h(
    'span',
    { class: 'list-row__title' },
    n.read ? '' : h('span', { class: 'unread-dot', 'aria-hidden': 'true' }),
    n.read ? '' : h('span', { class: 'visually-hidden unread-text', text: '未读：' }),
    n.actorName ? `${n.actorName} ` : '',
    KIND[n.kind] ?? '通知',
  );
  const sub = h('span', { class: 'list-row__sub' }, n.excerpt ? `${n.excerpt} · ` : '', timeEl(n.createdAt));
  const main = h('span', { class: 'list-row__main' }, title, h('br'), sub);
  const li = h('li', { 'data-id': String(n.id), class: n.read ? '' : 'is-unread' });
  const markRead = async () => {
    if (n.read) return;
    n.read = true;
    li.classList.remove('is-unread');
    li.querySelectorAll('.unread-dot, .unread-text').forEach((x) => x.remove());
    await getRepository()
      .notifications.markRead([n.id])
      .catch(() => {});
    announce();
  };
  if (href) {
    const a = h('a', { class: 'list-row', href }, main);
    a.addEventListener('click', (e) => {
      if (n.read) return;
      e.preventDefault();
      void markRead().finally(() => location.assign(href));
    });
    li.append(a);
  } else {
    const b = h('button', { type: 'button', class: 'list-row list-row--button' }, main);
    b.addEventListener('click', () => void markRead());
    li.append(b);
  }
  return li;
}

async function init() {
  const me = await viewer();
  if (!me) {
    list.hidden = true;
    root.querySelector<HTMLElement>('[data-signed-out]')!.hidden = false;
    setStatus(root, '', 'online');
    return;
  }
  try {
    const items = await getRepository().notifications.list({ limit: 100 });
    list.removeAttribute('aria-busy');
    if (items.length) list.replaceChildren(...items.map(row));
    else list.replaceChildren(h('li', { class: 'list-empty' }, h('p', { text: '暂时没有通知。' })));
    tools.hidden = !items.some((n) => !n.read);
    setStatus(root, '', 'online');
  } catch (e) {
    list.removeAttribute('aria-busy');
    list.replaceChildren();
    setStatus(root, friendlyError(e, '通知暂时无法加载，请稍后再试。'), 'offline');
  }
}

markAll.addEventListener('click', async () => {
  try {
    await busy(markAll, () => getRepository().notifications.markRead());
    list.querySelectorAll('.is-unread').forEach((li) => li.classList.remove('is-unread'));
    list.querySelectorAll('.unread-dot, .unread-text').forEach((d) => d.remove());
    tools.hidden = true;
    announce();
  } catch (e) {
    toastError(e);
  }
});

void init();
