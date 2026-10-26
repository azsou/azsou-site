/**
 * 论坛列表 island：站点种子主题已静态渲染（可被收录、零 JS 可读）；
 * 这里在其下方的「社区主题」区加载数据库主题：置顶在前，其余按时间倒序游标分页（加载更多）。
 * 社区区预留了骨架行高度，加载完成替换骨架，不推动上方内容（无布局偏移）。
 */
import { CATEGORY_NAMES, getRepository, type Thread } from '@/lib/data';
import { url } from '@/lib/routes';
import { friendlyError } from '@/lib/community-errors';
import { setStatus, shortDate } from '../render';
import { busy, h } from './ui';

const PAGE = 20;

function row(t: Thread, replies: number, showCat: boolean): HTMLLIElement {
  const title = h('span', { class: 'list-row__title' });
  if (t.pinned) title.append(h('span', { class: 'badge', text: '置顶' }), ' ');
  if (t.featured) title.append(h('span', { class: 'badge badge--accent', text: '精华' }), ' ');
  if (t.locked) title.append(h('span', { class: 'badge badge--muted', text: '已锁定' }), ' ');
  title.append(t.title);
  const sub = h('span', {
    class: 'list-row__sub',
    text: `${showCat ? `${CATEGORY_NAMES[t.category] ?? ''} · ` : ''}${t.author.name} · ${shortDate(t.createdAt)}`,
  });
  return h(
    'li',
    { 'data-source': 'db', 'data-thread-id': t.id },
    h(
      'a',
      { class: 'list-row', href: url.forumThread(t.id) },
      h('span', { class: 'list-row__main' }, title, h('br'), sub),
      h('span', { class: 'list-row__aside', 'data-replies': '', text: `${replies} 回复` }),
    ),
  );
}

export async function hydrateList(root: HTMLElement) {
  const repo = getRepository();
  const category = root.dataset.category || undefined;
  const list = root.querySelector<HTMLElement>('[data-db-list]')!;
  const more = root.querySelector<HTMLButtonElement>('[data-more]')!;
  const seedRows = [...root.querySelectorAll<HTMLElement>('[data-seed-id]')];
  let cursor: string | null = null;
  let shown = 0;

  const counts = async (ids: string[]) =>
    repo.forum.replyCountsFor(ids).catch(() => ({}) as Record<string, number>);

  const append = async (threads: Thread[], first: boolean) => {
    const c = await counts(threads.map((t) => t.id));
    const rows = threads.map((t) => row(t, c[t.id] ?? 0, !category));
    if (first) list.replaceChildren(...rows);
    else list.append(...rows);
    shown += threads.length;
  };

  try {
    const [pinned, page, seedCounts] = await Promise.all([
      repo.forum.pinnedThreads({ category }),
      repo.forum.pageThreads({ category, limit: PAGE, excludePinned: true }),
      counts(seedRows.map((li) => li.dataset.seedId!)),
    ]);
    for (const li of seedRows) {
      const n = seedCounts[li.dataset.seedId!] ?? 0;
      const aside = li.querySelector('.list-row__aside');
      if (aside) aside.textContent = `${Number(li.dataset.seedReplies || 0) + n} 回复`;
    }
    await append([...pinned, ...page.items], true);
    cursor = page.next;
    if (!shown)
      list.replaceChildren(
        h('li', { class: 'list-empty' }, h('p', { text: '还没有社区主题。来发第一个吧！' })),
      );
    list.removeAttribute('aria-busy');
    more.hidden = !cursor;
    setStatus(root, '', 'online');
  } catch {
    list.removeAttribute('aria-busy');
    list.replaceChildren(
      h('li', { class: 'list-empty' }, h('p', { text: '社区主题暂时无法加载，站点预置主题照常可读。' })),
    );
    setStatus(root, '论坛后端暂时不可达，当前为只读模式。', 'offline');
    return;
  }

  more.addEventListener('click', async () => {
    try {
      await busy(more, async () => {
        const page = await repo.forum.pageThreads({ category, limit: PAGE, cursor, excludePinned: true });
        await append(page.items, false);
        cursor = page.next;
        more.hidden = !cursor;
        // 焦点移到新加载的第一条，键盘用户不必回头找
        list.querySelector<HTMLElement>(`li:nth-child(${shown - page.items.length + 1}) a`)?.focus();
      });
    } catch (e) {
      setStatus(root, friendlyError(e), 'offline');
    }
  });
}

document.querySelectorAll<HTMLElement>('[data-forum-list]').forEach((r) => void hydrateList(r));
