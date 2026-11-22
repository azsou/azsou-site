/** 后台「邮件订阅」（T7.8）：只读数量。读取失败显示分类错误 + 可重试（A15），不显示 0 冒充真实数量。 */
import { getGuestbook } from '@/lib/data/guestbook';
import { initAdmin, h } from './shell';
import { showError, showLoading } from './table';

const LABEL = { confirmed: '已订阅', pending: '待确认', unsubscribed: '已退订' } as const;
const body = document.querySelector<HTMLElement>('[data-sub-counts]')!;
let seq = 0;

async function load() {
  const my = ++seq;
  showLoading(body, 4);
  try {
    const rows = await getGuestbook().subscriberCounts();
    if (my !== seq) return;
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
    if (my !== seq) return;
    showError(body, 4, e, () => void load());
  } finally {
    if (my === seq) body.removeAttribute('aria-busy');
  }
}

async function main() {
  const me = await initAdmin();
  if (!me) return;
  await load();
}
void main();
