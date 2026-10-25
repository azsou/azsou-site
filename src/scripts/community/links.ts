/** /links/（T7.4）：已通过的友链 + 申请表单 */
import { checkLink } from '@/lib/community-forms';
import { getGuestbook, type FriendLink } from '@/lib/data/guestbook';
import { initSubmitForm } from './submit-form';

const list = document.querySelector<HTMLUListElement>('[data-links]')!;
const status = document.querySelector<HTMLElement>('[data-links-status]')!;
const total = document.querySelector<HTMLElement>('[data-total]')!;

function linkNode(l: FriendLink): HTMLLIElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'link-card';
  a.href = l.url;
  a.rel = 'noopener';
  const name = document.createElement('span');
  name.className = 'link-card__name';
  name.textContent = l.name;
  const host = document.createElement('span');
  host.className = 'link-card__host';
  host.textContent = new URL(l.url).host;
  a.append(name, host);
  if (l.description) {
    const d = document.createElement('span');
    d.className = 'link-card__desc';
    d.textContent = l.description;
    a.append(d);
  }
  li.append(a);
  return li;
}

async function load() {
  list.setAttribute('aria-busy', 'true');
  try {
    const links = (await getGuestbook().listLinks()).filter((l) => /^https:\/\//.test(l.url));
    list.replaceChildren(...links.map(linkNode));
    total.textContent = links.length ? String(links.length) : '';
    status.textContent = links.length ? '' : '还没有友链。欢迎在下方申请第一个。';
  } catch {
    status.textContent = '友链暂时无法加载（数据服务不可达），稍后再来看看。申请友链不受影响。';
  } finally {
    list.removeAttribute('aria-busy');
  }
}

initSubmitForm(
  document.querySelector<HTMLFormElement>('[data-link-form]')!,
  'link',
  checkLink,
  '申请已提交，谢谢！审核通过后会出现在上方列表。',
);
void load();
