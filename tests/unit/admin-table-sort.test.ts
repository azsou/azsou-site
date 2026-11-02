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

  it('窄屏卡片：表头控件移出 Tab 顺序，工具条下拉复用同一排序状态并派发 table2:sort；回到宽屏恢复', () => {
    let listener: (() => void) | null = null;
    const mq = { matches: true, addEventListener: (_: string, f: () => void) => (listener = f) };
    const orig = window.matchMedia;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    const origCV = (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
    // jsdom 不做布局：本用例里所有控件都视为可见
    (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    try {
      document.body.innerHTML = `<div class="table-wrap"><table class="data-table" data-cards data-server-sort data-table2="t-cards">
        <thead><tr><th class="col-check"><span>选择</span></th><th data-sort-key="title">内容</th><th>备注</th><th data-sort-key="published">状态</th></tr></thead>
        <tbody><tr data-row><td><input type="checkbox"></td><td>甲</td><td>x</td><td>已发布</td></tr></tbody>
      </table></div>`;
      const table = document.querySelector('table')!;
      const events: unknown[] = [];
      table.addEventListener('table2:sort', (e) => events.push((e as CustomEvent).detail));
      enhanceTable(table);
      const ctrls = [...table.querySelectorAll<HTMLElement>('thead .th-sort, thead .th-resize')];
      expect(ctrls.length).toBeGreaterThan(0);
      expect(ctrls.every((el) => el.tabIndex === -1)).toBe(true);
      // 表头文字仍在（辅助技术 / 数据关联）
      expect(table.querySelector('thead th:nth-child(2)')!.textContent).toContain('内容');
      const sel = document.querySelector<HTMLSelectElement>('.table-tools__sort select')!;
      expect([...sel.options].map((o) => o.value)).toEqual([
        '',
        '2:ascending',
        '2:descending',
        '4:ascending',
        '4:descending',
      ]);
      sel.value = '4:descending';
      sel.dispatchEvent(new Event('change'));
      expect(events.at(-1)).toEqual({ key: 'published', dir: 'desc' });
      expect(table.querySelector('thead th:nth-child(4)')!.getAttribute('aria-sort')).toBe('descending');
      sel.value = '';
      sel.dispatchEvent(new Event('change'));
      expect(events.at(-1)).toBeNull();
      expect(table.querySelector('thead th[aria-sort]')).toBeNull();
      // 表头按钮点击后，下拉同步显示同一状态
      table.querySelector<HTMLButtonElement>('[data-sort-col="2"]')!.click();
      expect(sel.value).toBe('2:ascending');
      // 窄屏焦点停在下拉 → 切到宽屏：焦点交给对应表头按钮，表头控件回到 Tab 顺序
      sel.focus();
      mq.matches = false;
      listener!();
      expect(document.activeElement).toBe(table.querySelector('[data-sort-col="2"]'));
      expect(table.querySelector<HTMLElement>('thead .th-resize')!.tabIndex).toBe(0);
      expect(table.querySelector<HTMLElement>('thead .th-sort')!.hasAttribute('tabindex')).toBe(false);
      // 宽屏焦点在表头 → 切到窄屏：焦点交给可见的排序下拉
      mq.matches = true;
      listener!();
      expect(document.activeElement).toBe(sel);
    } finally {
      window.matchMedia = orig;
      if (origCV === undefined)
        delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
      else (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility = origCV;
    }
  });

  it('回到宽屏时对应列仍隐藏：焦点交给可见表头 / 工具条，不改排序、不派发排序、不改隐藏偏好', () => {
    let listener: (() => void) | null = null;
    const mq = { matches: true, addEventListener: (_: string, f: () => void) => (listener = f) };
    const orig = window.matchMedia;
    const origCV = (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    // jsdom 不做布局：用 th[data-test-hidden] 模拟被 data-priority / data-hide 隐藏的列
    (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = function (
      this: HTMLElement,
    ) {
      return !this.closest('[data-test-hidden]');
    };
    try {
      document.body.innerHTML = `<div class="table-wrap"><table class="data-table" data-cards data-server-sort data-table2="t-hidden">
        <thead><tr><th class="col-check"><span>选择</span></th><th data-sort-key="title">内容</th><th>备注</th><th data-sort-key="created_at">注册时间</th></tr></thead>
        <tbody><tr data-row><td><input type="checkbox"></td><td>甲</td><td>x</td><td>2026</td></tr></tbody>
      </table></div>`;
      const table = document.querySelector('table')!;
      const events: unknown[] = [];
      table.addEventListener('table2:sort', (e) => events.push((e as CustomEvent).detail));
      enhanceTable(table);
      const sel = document.querySelector<HTMLSelectElement>('.table-tools__sort select')!;
      sel.value = '4:ascending';
      sel.dispatchEvent(new Event('change'));
      expect(events).toEqual([{ key: 'created_at', dir: 'asc' }]);
      const hideBefore = table.dataset.hide ?? '';
      // 路径 A/B 的共同形态：目标列（第 4 列）在宽屏下仍隐藏
      table.querySelector('thead th:nth-child(4)')!.setAttribute('data-test-hidden', '');
      sel.focus();
      mq.matches = false;
      listener!();
      expect(document.activeElement).toBe(table.querySelector('[data-sort-col="2"]'));
      expect(document.activeElement).not.toBe(document.body);
      expect(sel.value).toBe('4:ascending');
      expect(table.querySelector('thead th:nth-child(4)')!.getAttribute('aria-sort')).toBe('ascending');
      expect(events).toHaveLength(1);
      expect(table.dataset.hide ?? '').toBe(hideBefore);
      // 所有表头排序按钮都不可见：交给工具条按钮
      mq.matches = true;
      listener!();
      expect(document.activeElement).toBe(sel);
      table.querySelector('thead')!.setAttribute('data-test-hidden', '');
      mq.matches = false;
      listener!();
      const active = document.activeElement as HTMLElement;
      expect(active).not.toBe(document.body);
      expect(active.closest('.table-tools')).not.toBeNull();
      expect(events).toHaveLength(1);
      // 焦点在行内控件：断点切换不移动它
      const cb = table.querySelector<HTMLInputElement>('tbody input')!;
      cb.focus();
      mq.matches = true;
      listener!();
      mq.matches = false;
      listener!();
      expect(document.activeElement).toBe(cb);
    } finally {
      window.matchMedia = orig;
      if (origCV === undefined)
        delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
      else (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility = origCV;
    }
  });
});
