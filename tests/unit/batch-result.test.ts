// @vitest-environment jsdom
/** A08：批量逐项结果的摘要、单条断言与「只重试失败项」面板 */
import { describe, expect, it, vi } from 'vitest';
import { batchFromRows, toBatchResult } from '@/lib/data/admin';
import { assertSingle, batchSummary, failedIds, renderBatchResult } from '@/scripts/admin/batch-result';

const r = toBatchResult({
  requested: 5,
  unique: 4,
  duplicates: 1,
  ok: 2,
  failed: 1,
  replayed: false,
  results: [
    { id: 'a', result: 'ok' },
    { id: 'b', result: 'unchanged' },
    { id: 'c', result: 'not_found' },
    { id: 'd', result: 'conflict', message: '状态已被他人修改，请刷新后重试' },
  ],
});

describe('批量逐项结果（A08）', () => {
  it('摘要按结果分类计数，合并重复单独说明', () => {
    expect(batchSummary(r, '隐藏')).toBe(
      '隐藏：成功 2 条；不存在（可能已被删除） 1，状态已被他人修改 1（已合并重复 1 项）。',
    );
    expect(batchSummary(toBatchResult({ ok: 3, results: [{ id: 'a', result: 'ok' }] }), '送审')).toBe(
      '已送审 1 条。',
    );
  });
  it('只重试冲突 / 被拒 / 失败项；不存在的不再重试', () => {
    expect(failedIds(r)).toEqual(['d']);
  });
  it('单条操作非成功时抛出可读错误', () => {
    expect(() => assertSingle(toBatchResult({ results: [{ id: 'x', result: 'not_found' }] }))).toThrow(
      '不存在',
    );
    expect(() => assertSingle(toBatchResult({ results: [{ id: 'x', result: 'ok' }] }))).not.toThrow();
  });
  it('面板：有失败项时出现「只重试失败的 N 条」，点击把失败 id 交给回调', () => {
    const box = document.createElement('div');
    const retry = vi.fn();
    renderBatchResult(box, r, '隐藏', retry);
    expect(box.hidden).toBe(false);
    expect(box.getAttribute('class')).toContain('notice--error');
    const btn = box.querySelector<HTMLButtonElement>('[data-bulk-retry]')!;
    expect(btn.textContent).toBe('只重试失败的 1 条');
    btn.click();
    expect(retry).toHaveBeenCalledWith(['d']);
    renderBatchResult(box, null, '隐藏');
    expect(box.hidden).toBe(true);
  });
  it('旧库退回：返回行 = ok，其余 = not_found，重复合并计数', () => {
    const b = batchFromRows(['a', 'b', 'a'], ['a']);
    expect(b).toMatchObject({ requested: 3, unique: 2, duplicates: 1, ok: 1 });
    expect(b.results).toEqual([
      { id: 'a', result: 'ok' },
      { id: 'b', result: 'not_found' },
    ]);
  });
});
