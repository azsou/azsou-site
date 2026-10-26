/** 后台「邮件订阅」（T7.8）：只读数量 */
import { getGuestbook } from '@/lib/data/guestbook';
import { friendlyError } from '@/lib/community-errors';
import { initAdmin, h } from './shell';

const LABEL = { confirmed: '已订阅', pending: '待确认', unsubscribed: '已退订' } as const;

async function main() {
  const me = await initAdmin();
  if (!me) return;
  const body = document.querySelector<HTMLElement>('[data-sub-counts]')!;
  const status = document.querySelector<HTMLElement>('[data-status]')!;
  try {
    const rows = await getGuestbook().subscriberCounts();
    const get = (s: string, l: string) => rows.find((r) => r.status === s && r.lang === l)?.n ?? 0;
    body.replaceChildren(
      ...(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((s) => {
        const zh = get(s, 'zh');
        const en = get(s, 'en');
        return h(
          'tr',
          { 'data-status-row': s },
          h('th', { scope: 'row' }, LABEL[s]),
          h('td', {}, String(zh)),
          h('td', {}, String(en)),
          h('td', {}, String(zh + en)),
        );
      }),
    );
  } catch (e) {
    status.textContent = friendlyError(e, '读取失败，请稍后再试。');
  } finally {
    body.removeAttribute('aria-busy');
  }
}
void main();
