/**
 * 列表页外壳 island（P10 T10.8）：排序（最新 / 名称 / 编辑推荐）、网格 / 列表切换、加载更多。
 * 只重排 / 切换已渲染的条目（[data-list-items] > li），不请求数据。排序键来自条目上的
 * data-sort-new / data-sort-name / data-sort-editor（src/lib/store.ts sortAttrs）。
 * 排序写进查询串 ?sort=（可分享），显示方式记在 localStorage（个人偏好，不进地址）。
 */
const VIEW_KEY = 'az-list-view';

for (const root of document.querySelectorAll<HTMLElement>('[data-list-shell]')) {
  const list = root.querySelector<HTMLElement>('[data-list-items]');
  if (!list) continue;
  const sortBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-entry-sort]')];
  const viewBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-view-set]')];
  const pageSize = Number(root.dataset.pageSize ?? 24);
  const defaultSort = root.dataset.defaultSort ?? 'new';

  const key = (li: Element, k: 'sortNew' | 'sortName' | 'sortEditor') => {
    const host =
      (li as HTMLElement).dataset[k] !== undefined
        ? (li as HTMLElement)
        : li.querySelector<HTMLElement>('[data-sort-new]');
    return host?.dataset[k] ?? '';
  };
  const items = () => [...list.children] as HTMLElement[];

  const applySort = (s: string, push: boolean) => {
    const xs = items();
    const editor = (li: Element) => Number(key(li, 'sortEditor') || 1e9);
    xs.sort((a, b) => {
      if (s === 'name')
        return key(a, 'sortName').localeCompare(key(b, 'sortName'), 'zh-CN') || editor(a) - editor(b);
      if (s === 'editor') return editor(a) - editor(b);
      return key(b, 'sortNew').localeCompare(key(a, 'sortNew')) || editor(a) - editor(b);
    });
    list.append(...xs);
    for (const b of sortBtns) b.setAttribute('aria-pressed', String(b.dataset.entrySort === s));
    if (push) {
      const q = new URLSearchParams(location.search);
      if (s === defaultSort) q.delete('sort');
      else q.set('sort', s);
      const qs = q.toString();
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    }
    paginate();
  };

  const applyView = (v: string) => {
    list.dataset.view = v === 'list' ? 'list' : 'grid';
    for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.viewSet === list.dataset.view));
  };

  // 加载更多：只数没被筛选隐藏（hidden）的条目
  const more = document.createElement('div');
  more.className = 'list-more';
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'btn';
  more.append(moreBtn);
  let limit = pageSize;
  const paginate = () => {
    if (!pageSize) return;
    let shown = 0;
    let rest = 0;
    for (const li of items()) {
      if (li.hidden) {
        li.removeAttribute('data-more-hidden');
        continue;
      }
      if (shown < limit) {
        shown++;
        li.removeAttribute('data-more-hidden');
      } else {
        rest++;
        li.setAttribute('data-more-hidden', '');
      }
    }
    moreBtn.textContent = `加载更多（还有 ${rest} 个）`;
    if (rest > 0 && !more.isConnected) list.after(more);
    if (rest === 0) more.remove();
  };
  moreBtn.addEventListener('click', () => {
    const first = items().find((li) => li.hasAttribute('data-more-hidden'));
    limit += pageSize;
    paginate();
    // 焦点移到新出现的第一个条目，键盘用户不用从头 Tab
    first?.querySelector<HTMLElement>('a')?.focus();
  });
  // 其它筛选脚本切换 hidden 后重新分批
  new MutationObserver(() => paginate()).observe(list, {
    subtree: false,
    attributes: true,
    attributeFilter: ['hidden'],
    childList: true,
  });
  for (const li of items())
    new MutationObserver(() => paginate()).observe(li, { attributes: true, attributeFilter: ['hidden'] });

  for (const b of sortBtns) {
    b.disabled = false;
    b.addEventListener('click', () => applySort(b.dataset.entrySort ?? defaultSort, true));
  }
  for (const b of viewBtns) {
    b.disabled = false;
    b.addEventListener('click', () => {
      applyView(b.dataset.viewSet ?? 'grid');
      try {
        localStorage.setItem(VIEW_KEY, list.dataset.view ?? 'grid');
      } catch {
        /* 隐私模式：不记 */
      }
    });
  }
  let saved = 'grid';
  try {
    saved = localStorage.getItem(VIEW_KEY) ?? 'grid';
  } catch {
    /* 忽略 */
  }
  applyView(saved);
  const s = new URLSearchParams(location.search).get('sort');
  if (s && sortBtns.some((b) => b.dataset.entrySort === s) && s !== defaultSort) applySort(s, false);
  else paginate();
  root.dataset.ready = 'yes';
}

export {};
