/** /guestbook/（T7.3）：已通过的留言（分页加载）+ 留言表单 */
import { checkGuestbook, GUESTBOOK_LIMITS } from '@/lib/community-forms';
import { getGuestbook, type GuestbookEntry } from '@/lib/data/guestbook';
import { shortDate } from '../render';
import { initSubmitForm } from './submit-form';

const list = document.querySelector<HTMLOListElement>('[data-gb-list]')!;
const status = document.querySelector<HTMLElement>('[data-gb-status]')!;
const more = document.querySelector<HTMLButtonElement>('[data-more]')!;
const total = document.querySelector<HTMLElement>('[data-total]')!;
const form = document.querySelector<HTMLFormElement>('[data-gb-form]')!;
const counter = form.querySelector<HTMLElement>('[data-counter]')!;
const body = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
const LIMIT = 20;
let offset = 0;

function entryNode(e: GuestbookEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'gb-entry';
  const head = document.createElement('p');
  head.className = 'gb-entry__head';
  const name = document.createElement('strong');
  name.textContent = e.nickname;
  const time = document.createElement('time');
  time.dateTime = e.createdAt;
  time.textContent = shortDate(e.createdAt);
  head.append(name, ' · ', time);
  const text = document.createElement('p');
  text.className = 'gb-entry__body';
  text.textContent = e.body;
  li.append(head, text);
  return li;
}

async function load() {
  more.disabled = true;
  list.setAttribute('aria-busy', 'true');
  try {
    const { items, total: n } = await getGuestbook().listEntries({ offset, limit: LIMIT });
    list.append(...items.map(entryNode));
    offset += items.length;
    total.textContent = n ? String(n) : '';
    more.hidden = offset >= n;
    status.textContent = n ? '' : '还没有公开的留言，来写第一条吧。';
  } catch {
    status.textContent = '留言暂时无法加载（数据服务不可达），稍后再来看看。写留言不受影响。';
  } finally {
    more.disabled = false;
    list.removeAttribute('aria-busy');
  }
}

more.addEventListener('click', () => void load());
const count = () => (counter.textContent = `（${[...body.value].length}/${GUESTBOOK_LIMITS.body}）`);
form.addEventListener('input', count);
count();
initSubmitForm(form, 'guestbook', checkGuestbook, '已提交，谢谢！站长审核通过后会显示在下方。');
form.dataset.ready = 'yes';
void load();
