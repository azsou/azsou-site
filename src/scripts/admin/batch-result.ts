/**
 * A08（0018）：批量操作的逐项结果面板——成功 / 无变化 / 不存在 / 冲突 / 被拒 / 失败分别计数，
 * 失败项（冲突 / 被拒 / 失败）可以「只重试失败项」；不存在的已被删除，不再重试。
 */
import type { BatchItemResult, BatchResult } from '@/lib/data/admin';
import { h } from './shell';

export const RESULT_LABEL: Record<BatchItemResult, string> = {
  ok: '成功',
  unchanged: '无变化',
  not_found: '不存在（可能已被删除）',
  conflict: '状态已被他人修改',
  denied: '无权限',
  failed: '失败',
};
const RETRYABLE: BatchItemResult[] = ['conflict', 'denied', 'failed'];

export const failedIds = (r: BatchResult) =>
  r.results.filter((x) => RETRYABLE.includes(x.result)).map((x) => x.id);

/** 一行摘要（toast / 读屏） */
export function batchSummary(r: BatchResult, verb: string): string {
  const counts = new Map<BatchItemResult, number>();
  for (const x of r.results) counts.set(x.result, (counts.get(x.result) ?? 0) + 1);
  const parts = [...counts.entries()]
    .filter(([k]) => k !== 'ok' && k !== 'unchanged')
    .map(([k, n]) => `${RESULT_LABEL[k]} ${n}`);
  const okN = (counts.get('ok') ?? 0) + (counts.get('unchanged') ?? 0) || (r.results.length ? 0 : r.ok);
  const dup = r.duplicates > 0 ? `（已合并重复 ${r.duplicates} 项）` : '';
  return parts.length
    ? `${verb}：成功 ${okN} 条；${parts.join('，')}${dup}。`
    : `已${verb} ${okN} 条${dup}。`;
}

/** 单条操作：不是成功 / 无变化就抛出可读错误 */
export function assertSingle(r: BatchResult) {
  const x = r.results[0];
  if (!x || x.result === 'ok' || x.result === 'unchanged') return;
  throw new Error(x.message && x.result !== 'conflict' ? x.message : RESULT_LABEL[x.result]);
}

/** 渲染结果面板；有失败项时给「只重试失败项」按钮 */
export function renderBatchResult(
  box: HTMLElement,
  r: BatchResult | null,
  verb: string,
  onRetry?: (ids: string[]) => void,
) {
  if (!r) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const failed = failedIds(r);
  const bad = r.results.filter((x) => x.result !== 'ok' && x.result !== 'unchanged');
  box.hidden = false;
  box.className = `notice ${failed.length ? 'notice--error' : bad.length ? 'notice--info' : 'notice--ok'} bulk-result`;
  const close = h('button', { type: 'button', class: 'btn btn--sm btn--text', text: '关闭' });
  close.addEventListener('click', () => renderBatchResult(box, null, verb));
  const list = bad.length
    ? h(
        'ul',
        { class: 'bulk-result__list' },
        ...bad
          .slice(0, 20)
          .map((x) =>
            h(
              'li',
              {},
              h('code', { text: x.id.slice(0, 8) }),
              ` ${RESULT_LABEL[x.result]}${x.message && x.result === 'failed' ? `：${x.message}` : ''}`,
            ),
          ),
        bad.length > 20 ? h('li', { text: `…另有 ${bad.length - 20} 条` }) : null,
      )
    : null;
  const retry =
    failed.length && onRetry
      ? h('button', {
          type: 'button',
          class: 'btn btn--sm',
          'data-bulk-retry': true,
          text: `只重试失败的 ${failed.length} 条`,
        })
      : null;
  retry?.addEventListener('click', () => onRetry!(failed));
  box.replaceChildren(
    h('p', { class: 'bulk-result__summary', 'data-bulk-summary': true, text: batchSummary(r, verb) }),
    ...(list ? [list] : []),
    h('div', { class: 'btn-row' }, retry, close),
  );
}
