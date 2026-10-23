import { getRepository, type Thread } from '@/lib/data';
import { url } from '@/lib/routes';
import { commentNode, paragraphs, setStatus, shortDate } from './render';

const CAT_NAMES: Record<string, string> = {
  announce: '公告',
  product: '产品讨论',
  tech: '技术交流',
  meta: '站务反馈',
};

function threadRow(t: Thread, replies: number): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.source = 'db';
  const a = document.createElement('a');
  a.className = 'list-row';
  a.href = url.forumThread(t.id);
  const main = document.createElement('span');
  main.className = 'list-row__main';
  const title = document.createElement('span');
  title.className = 'list-row__title';
  title.textContent = t.title;
  const sub = document.createElement('span');
  sub.className = 'list-row__sub';
  sub.textContent = `${CAT_NAMES[t.category] ?? t.category} · ${t.author.name} · ${shortDate(t.createdAt)}`;
  main.append(title, document.createElement('br'), sub);
  const aside = document.createElement('span');
  aside.className = 'list-row__aside';
  aside.textContent = `${replies} 回复`;
  a.append(main, aside);
  li.append(a);
  return li;
}

/** 列表：追加数据库里的用户主题（种子主题已静态渲染） */
async function hydrateList(root: HTMLElement) {
  const list = root.querySelector('[data-list]')!;
  const category = root.dataset.category || undefined;
  const repo = getRepository();
  try {
    const [threads, counts] = await Promise.all([
      repo.forum.listThreads({ category }),
      repo.forum.replyCounts(),
    ]);
    // 种子主题的回复数 = 预置回复 + 数据库回复
    list.querySelectorAll<HTMLElement>('[data-seed-id]').forEach((li) => {
      const n = counts[li.dataset.seedId!] ?? 0;
      const base = Number(li.dataset.seedReplies || 0);
      const aside = li.querySelector('.list-row__aside');
      if (aside) aside.textContent = `${base + n} 回复`;
    });
    threads.forEach((t) => list.append(threadRow(t, counts[t.id] ?? 0)));
    const empty = root.querySelector<HTMLElement>('[data-empty]');
    if (empty && list.children.length) empty.hidden = true;
    setStatus(root, `已加载 ${threads.length} 个用户主题（只读预览）。发帖将在 v2 P3 开放。`, 'online');
  } catch {
    setStatus(root, '论坛后端暂时不可达，当前为只读模式：仅显示站点预置主题。', 'offline');
  }
}

/** 种子主题页：追加数据库里的回复 */
async function hydrateReplies(root: HTMLElement) {
  const list = root.querySelector('[data-list]')!;
  const count = root.querySelector('[data-count]');
  const seeds = list.querySelectorAll('[data-source="seed"]').length;
  try {
    const rows = await getRepository().forum.listReplies(root.dataset.threadId!);
    rows.forEach((r) => list.append(commentNode(r)));
    if (count) count.textContent = `${seeds + rows.length} 条回复`;
    setStatus(root, '只读预览：回帖将在 v2 P3 开放。', 'online');
  } catch {
    setStatus(root, '论坛后端暂时不可达，当前为只读模式。', 'offline');
  }
}

/** 动态主题页 /forum/thread/?id= ：整页由数据库渲染（P3 改为服务端渲染） */
async function hydrateDynamic(root: HTMLElement) {
  const id = new URLSearchParams(location.search).get('id');
  const title = root.querySelector<HTMLElement>('[data-title]')!;
  const meta = root.querySelector<HTMLElement>('[data-meta]')!;
  const body = root.querySelector<HTMLElement>('[data-body]')!;
  const list = root.querySelector('[data-list]')!;
  if (!id) {
    title.textContent = '缺少主题编号';
    setStatus(root, '链接不完整。', 'offline');
    return;
  }
  try {
    const repo = getRepository();
    const [t, replies] = await Promise.all([repo.forum.getThread(id), repo.forum.listReplies(id)]);
    if (!t) {
      title.textContent = '主题不存在或已删除';
      setStatus(root, '', 'online');
      return;
    }
    document.title = `${t.title} · 论坛 · AZ Studio`;
    title.textContent = t.title;
    meta.textContent = `${CAT_NAMES[t.category] ?? t.category} · ${t.author.name} · ${shortDate(t.createdAt)}`;
    body.replaceChildren(paragraphs(t.body));
    replies.forEach((r) => list.append(commentNode(r)));
    const count = root.querySelector('[data-count]');
    if (count) count.textContent = `${replies.length} 条回复`;
    setStatus(root, '只读预览：回帖将在 v2 P3 开放。', 'online');
  } catch {
    title.textContent = '暂时无法加载这个主题';
    setStatus(root, '论坛后端暂时不可达，请稍后再试。', 'offline');
  }
}

document.querySelectorAll<HTMLElement>('[data-forum-list]').forEach((r) => void hydrateList(r));
document.querySelectorAll<HTMLElement>('[data-forum-replies]').forEach((r) => void hydrateReplies(r));
document.querySelectorAll<HTMLElement>('[data-forum-dynamic]').forEach((r) => void hydrateDynamic(r));
