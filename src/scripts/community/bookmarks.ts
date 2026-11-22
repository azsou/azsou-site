/** /bookmarks/：我的收藏（数据库主题 + 站点种子主题），可取消收藏。 */
import { CATEGORY_NAMES, getRepository, type Thread } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';
import { url } from '@/lib/routes';
import { setStatus, shortDate } from '../render';
import { busy, h, toast, toastError, viewer } from './ui';

const root = document.querySelector<HTMLElement>('[data-bookmarks]')!;
const list = root.querySelector<HTMLElement>('[data-list]')!;
const seeds = JSON.parse(document.querySelector('[data-seeds]')?.textContent || '{}') as Record<
  string,
  { title: string; category: string; date: string }
>;

function row(key: string, title: string, sub: string) {
  const remove = h('button', {
    type: 'button',
    class: 'act act--danger',
    'data-act': 'unbookmark',
    text: '取消收藏',
  });
  remove.setAttribute('aria-label', `取消收藏：${title}`);
  const li = h(
    'li',
    { class: 'list-row list-row--split', 'data-key': key },
    h(
      'a',
      { class: 'list-row__main', href: url.forumThread(key) },
      h('span', { class: 'list-row__title', text: title }),
      h('br'),
      h('span', { class: 'list-row__sub', text: sub }),
    ),
    remove,
  );
  remove.addEventListener('click', async () => {
    try {
      await busy(remove, () => getRepository().bookmarks.remove(key));
      li.remove();
      toast('已取消收藏。');
      if (!list.children.length) empty();
    } catch (e) {
      toastError(e);
    }
  });
  return li;
}
const empty = () =>
  list.replaceChildren(
    h('li', { class: 'list-empty' }, h('p', { text: '还没有收藏。去论坛逛逛，在喜欢的主题页点「收藏」。' })),
  );

async function init() {
  const me = await viewer();
  if (!me) {
    list.hidden = true;
    root.querySelector<HTMLElement>('[data-signed-out]')!.hidden = false;
    setStatus(root, '', 'online');
    return;
  }
  try {
    const repo = getRepository();
    const marks = await repo.bookmarks.list();
    const threads = await repo.forum.getThreadsByIds(marks.map((m) => m.threadKey));
    const byId = new Map<string, Thread>(threads.map((t) => [t.id, t]));
    const rows: HTMLElement[] = [];
    for (const m of marks) {
      const seed = seeds[m.threadKey];
      const t = byId.get(m.threadKey);
      if (seed)
        rows.push(
          row(m.threadKey, seed.title, `${CATEGORY_NAMES[seed.category] ?? ''} · 站点主题 · ${seed.date}`),
        );
      else if (t)
        rows.push(
          row(
            t.id,
            t.title,
            `${CATEGORY_NAMES[t.category] ?? ''} · ${t.author.name} · ${shortDate(t.createdAt)}`,
          ),
        );
      else rows.push(row(m.threadKey, '（主题已删除或不可见）', `收藏于 ${shortDate(m.createdAt)}`));
    }
    list.removeAttribute('aria-busy');
    if (rows.length) list.replaceChildren(...rows);
    else empty();
    setStatus(root, `共 ${rows.length} 个收藏`, 'online');
  } catch (e) {
    list.removeAttribute('aria-busy');
    list.replaceChildren();
    setStatus(root, friendlyError(e, '收藏暂时无法加载，请稍后再试。'), 'offline');
  }
}
void init();
