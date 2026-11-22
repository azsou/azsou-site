/**
 * 通用「单套筛选」island（T9.12，/games/、/works/）：一组分段按钮按一个字段筛选已渲染的条目。
 * 结构：[data-list-filter data-param="kind"] 内的 button[data-value]（"" = 全部）；
 * 条目是 [data-filter-item][data-filter-value]（可以是卡片，也可以是整个分组 section）。
 * 只切换 hidden，不重新渲染；状态写进查询串（replaceState，可分享），带查询串打开时恢复；未知值忽略。
 * 无 JS 时按钮保持 disabled、条目全部显示。
 */
for (const box of document.querySelectorAll<HTMLElement>('[data-list-filter]')) {
  const param = box.dataset.param ?? 'kind';
  const buttons = [...box.querySelectorAll<HTMLButtonElement>('button[data-value]')];
  const items = [...document.querySelectorAll<HTMLElement>('[data-filter-item]')];
  const status = document.querySelector<HTMLElement>('[data-list-status]');
  const noun = status?.dataset.noun ?? '项';
  const known = new Set(buttons.map((b) => b.dataset.value ?? ''));
  let value = new URLSearchParams(location.search).get(param) ?? '';
  if (!known.has(value)) value = '';

  const apply = (push: boolean) => {
    let n = 0;
    for (const el of items) {
      const show = !value || el.dataset.filterValue === value;
      el.hidden = !show;
      if (show) n += Number(el.dataset.filterCount ?? 1);
    }
    for (const b of buttons) b.setAttribute('aria-pressed', String((b.dataset.value ?? '') === value));
    if (status) status.textContent = `共 ${n} ${noun}${value ? ` · ${value}` : ''}`;
    if (push) {
      const q = new URLSearchParams(location.search);
      if (value) q.set(param, value);
      else q.delete(param);
      const qs = q.toString();
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    }
  };

  for (const b of buttons) {
    b.disabled = false;
    b.addEventListener('click', () => {
      value = b.dataset.value ?? '';
      apply(true);
    });
  }
  box.dataset.ready = 'yes';
  if (value) apply(false);
}

export {};
