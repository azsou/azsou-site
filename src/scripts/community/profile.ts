/** /u/?id=<uuid>：公开资料（昵称、角色、加入时间）+ 发过的主题（分页）+ 举报用户。 */
import { CATEGORY_NAMES, getRepository, type Thread } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';
import { url } from '@/lib/routes';
import { initials, setStatus, shortDate } from '../render';
import { busy, h, reportDialog, roleLabel, toastError, viewer } from './ui';

const root = document.querySelector<HTMLElement>('[data-profile]')!;
const list = root.querySelector<HTMLElement>('[data-list]')!;
const more = root.querySelector<HTMLButtonElement>('[data-more]')!;
const name = root.querySelector<HTMLElement>('[data-name]')!;
const joined = root.querySelector<HTMLElement>('[data-joined]')!;
const PAGE = 20;

function noindex() {
  const m = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (m) m.content = 'noindex,follow';
}

const row = (t: Thread) =>
  h(
    'li',
    {},
    h(
      'a',
      { class: 'list-row', href: url.forumThread(t.id) },
      h(
        'span',
        { class: 'list-row__main' },
        h('span', { class: 'list-row__title', text: t.title }),
        h('br'),
        h('span', {
          class: 'list-row__sub',
          text: `${CATEGORY_NAMES[t.category] ?? ''} · ${shortDate(t.createdAt)}`,
        }),
      ),
    ),
  );

async function init() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    noindex();
    name.textContent = '缺少用户编号';
    joined.textContent = '链接不完整。';
    list.removeAttribute('aria-busy');
    list.replaceChildren();
    setStatus(root, '', 'online');
    return;
  }
  const repo = getRepository();
  try {
    const [p, me, page] = await Promise.all([
      repo.profiles.get(id),
      viewer(),
      repo.forum.pageThreads({ author: id, limit: PAGE }),
    ]);
    list.removeAttribute('aria-busy');
    if (!p) {
      noindex();
      name.textContent = '用户不存在';
      joined.textContent = '这个账号可能已被注销。';
      list.replaceChildren();
      setStatus(root, '', 'online');
      return;
    }
    document.title = `${p.displayName} · 用户主页 · AZ Studio`;
    root.querySelector('[data-initials]')!.textContent = initials(p.displayName);
    name.replaceChildren(p.displayName);
    const role = roleLabel(p);
    if (role) name.append(' ', h('span', { class: 'badge', text: role }));
    joined.textContent = `${shortDate(p.createdAt)} 加入${p.banned ? ' · 已被限制发言' : ''}`;
    if (me && me.id !== p.id) {
      const rep = h('button', { type: 'button', class: 'act', 'data-act': 'report', text: '举报该用户' });
      rep.addEventListener('click', () => void reportDialog('profile', p.id));
      root.querySelector('[data-actions]')!.append(rep);
    }
    if (me?.id === p.id)
      root
        .querySelector('[data-actions]')!
        .append(h('a', { class: 'act', href: '/settings/', text: '编辑资料' }));
    let cursor = page.next;
    if (page.items.length) list.replaceChildren(...page.items.map(row));
    else list.replaceChildren(h('li', { class: 'list-empty' }, h('p', { text: '还没有发过主题。' })));
    more.hidden = !cursor;
    more.addEventListener('click', async () => {
      try {
        await busy(more, async () => {
          const next = await repo.forum.pageThreads({ author: id, limit: PAGE, cursor });
          list.append(...next.items.map(row));
          cursor = next.next;
          more.hidden = !cursor;
        });
      } catch (e) {
        toastError(e);
      }
    });
    setStatus(root, '', 'online');
  } catch (e) {
    list.removeAttribute('aria-busy');
    list.replaceChildren();
    name.textContent = '暂时无法加载';
    setStatus(root, friendlyError(e, '数据服务暂时不可达，请稍后再试。'), 'offline');
  }
}
void init();
