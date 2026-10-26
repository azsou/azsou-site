// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { compareCells, enhanceTable } from '@/scripts/admin/table2';

describe('数据表列排序 compareCells（T10.17）', () => {
  it('数字按数值（含千分位与百分号），不按字符串', () => {
    const v = ['10', '9', '1,200', '35%'];
    expect([...v].sort((a, b) => compareCells(a, b))).toEqual(['9', '10', '35%', '1,200']);
  });
  it('日期按时间；降序反过来', () => {
    const v = ['2026-10-02', '2026-9-30', '2025-12-31'];
    expect([...v].sort((a, b) => compareCells(a, b))).toEqual(['2025-12-31', '2026-9-30', '2026-10-02']);
    expect([...v].sort((a, b) => compareCells(a, b, 'descending'))[0]).toBe('2026-10-02');
  });
  it('中文按拼音序，空值总在最后（升降序都是）', () => {
    expect(['张三', '', '安娜'].sort((a, b) => compareCells(a, b))).toEqual(['安娜', '张三', '']);
    expect(['张三', '', '安娜'].sort((a, b) => compareCells(a, b, 'descending'))).toEqual([
      '张三',
      '安娜',
      '',
    ]);
  });
  it('点表头：升序 → 降序 → 恢复服务端顺序，th 带 aria-sort', () => {
    document.body.innerHTML = `<div class="table-wrap"><table class="data-table" data-table2="t-sort">
      <thead><tr><th>标题</th><th>回复</th><th>操作</th></tr></thead>
      <tbody><tr><td>乙</td><td>3</td><td></td></tr><tr><td>甲</td><td>12</td><td></td></tr><tr><td>丙</td><td>1</td><td></td></tr></tbody>
    </table></div>`;
    const table = document.querySelector('table')!;
    enhanceTable(table);
    const col = () => [...table.tBodies[0]!.rows].map((r) => r.cells[1]!.textContent);
    const btn = table.querySelector<HTMLButtonElement>('[data-sort-col="2"]')!;
    expect(table.querySelector('[data-sort-col="3"]')).toBeNull();
    btn.click();
    expect(col()).toEqual(['1', '3', '12']);
    expect(btn.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    btn.click();
    expect(col()).toEqual(['12', '3', '1']);
    btn.click();
    expect(col()).toEqual(['3', '12', '1']);
    expect(btn.closest('th')!.hasAttribute('aria-sort')).toBe(false);
  });
});
