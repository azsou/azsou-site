/**
 * 数据表 2.0（P10h T10.17）：给 `table.data-table[data-table2="<key>"]` 加工具条——
 *  - 密度：标准 52 / 紧凑 40（记忆到 localStorage）；
 *  - 列管理：勾选显示 / 隐藏列（主列、复选、操作列不能隐藏），记忆；
 *  - 保存视图：当前筛选（URL 查询串）+ 隐藏列 + 密度存成命名视图，一键切换 / 删除（只存在本浏览器）；
 *  - 导出 CSV：导出当前页可见列（服务端分页：每页由各页面脚本向数据库按 offset / limit 拉取）；
 *  - 列排序：点表头切换 升序 / 降序 / 默认（th[aria-sort]，记忆）。表格带 data-server-sort 时只有带
 *    th[data-sort-key] 的列可排，点击派发 `table2:sort` 事件（detail = { key, dir } | null），由页面脚本带上
 *    p_sort / p_dir 向数据库重新取数（迁移 0017）；否则只对当前页排序，表格重新渲染后自动重排。
 *  - 列宽：拖动表头右缘（或聚焦后按 ← / →）调整，双击恢复；记忆到本浏览器（CSSOM 设置宽度，不写 style 属性）。
 * 吸顶表头 + 固定首列 / 操作列由 admin.css 的 [data-table2] 规则完成（.table-wrap[data-scroll] 自己滚动）。
 * 无内联样式：隐藏列写成 table[data-hide="3 5"]，CSS 按列序号隐藏。
 */
import { toCsv } from '@/lib/csv';
import { download, h, stamp } from './shell';

/** 元素是否实际渲染、可见（祖先 display:none / visibility:hidden 都算不可见）。 */
export function isShown(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  return el.getClientRects().length > 0;
}

export type Density = 'standard' | 'compact';
export interface SavedView {
  name: string;
  search: string;
  hide: number[];
  density: Density;
}
export type SortDir = 'ascending' | 'descending';
interface Prefs {
  hide: number[];
  density: Density;
  sort?: { col: number; dir: SortDir } | null;
  widths?: Record<string, number>;
}

export interface ServerSort {
  key: string;
  dir: 'asc' | 'desc';
}
/** 服务端排序表格当前（记忆的）排序；没有则 null */
export function serverSort(table: HTMLTableElement): ServerSort | null {
  const prefs = readJson<Partial<Prefs>>(prefKey(table.dataset.table2 || location.pathname), {});
  if (!prefs.sort) return null;
  const th = table.querySelector<HTMLTableCellElement>(`thead th:nth-child(${prefs.sort.col})`);
  const key = th?.dataset.sortKey;
  return key ? { key, dir: prefs.sort.dir === 'ascending' ? 'asc' : 'desc' } : null;
}

/** 单元格文本比较：都是数字（可带 , 与 %）按数值，像日期按时间，否则按中文拼音序；空值总在最后 */
export function compareCells(a: string, b: string, dir: SortDir = 'ascending'): number {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return x === y ? 0 : x ? -1 : 1;
  const num = (v: string) => (/^[-+]?[\d,]+(\.\d+)?%?$/.test(v) ? Number(v.replace(/[,%]/g, '')) : NaN);
  const date = (v: string) =>
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v) ? Date.parse(v.replace(/[/.]/g, '-')) : NaN;
  let r: number;
  if (!Number.isNaN(num(x)) && !Number.isNaN(num(y))) r = num(x) - num(y);
  else if (!Number.isNaN(date(x)) && !Number.isNaN(date(y))) r = date(x) - date(y);
  else r = x.localeCompare(y, 'zh-CN', { numeric: true });
  return dir === 'ascending' ? r : -r;
}

const prefKey = (k: string) => `az-admin-table:${k}`;
const viewKey = (k: string) => `az-admin-views:${k}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 隐私模式：不记忆 */
  }
}

/** 列定义：第 n 列（1 起），能否隐藏（复选 / 主列 / 操作列不行） */
export function columnsOf(table: HTMLTableElement): { n: number; label: string; locked: boolean }[] {
  return [...table.querySelectorAll<HTMLTableCellElement>('thead th')].map((th, i) => ({
    n: i + 1,
    label: th.textContent?.replace(/\s+/g, ' ').trim() || `第 ${i + 1} 列`,
    locked:
      i === 0 ||
      th.classList.contains('col-check') ||
      th.classList.contains('col-actions') ||
      (i === 1 && !!table.querySelector('thead th.col-check')),
  }));
}

/** 当前页可见数据 → CSV 行（跳过复选 / 操作列、隐藏列与状态行） */
export function tableRows(table: HTMLTableElement, hide: number[]): { cols: string[]; rows: string[][] } {
  const cols = columnsOf(table).filter(
    (c) => !hide.includes(c.n) && !/^(选择|操作)$/.test(c.label) && c.label !== '',
  );
  const rows = [...table.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row]')].map((tr) =>
    cols.map((c) => (tr.children[c.n - 1]?.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  return { cols: cols.map((c) => c.label), rows };
}

/** 每张表的断点交接监听（重复初始化先撤销旧的，避免重复监听；表格脱离文档时撤销） */
const handoffs = new WeakMap<HTMLTableElement, AbortController>();

let popSeq = 0;
function popover(label: string, icon: string, build: (panel: HTMLElement, close: () => void) => void) {
  const id = `tpop-${++popSeq}`;
  const btn = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--outline btn--rect',
    'aria-expanded': 'false',
    'aria-controls': id,
  });
  btn.innerHTML = icon;
  btn.append(document.createTextNode(label));
  const panel = h('div', { class: 'table-pop__panel', id, role: 'group', 'aria-label': label, hidden: true });
  const wrap = h('div', { class: 'table-pop' }, btn, panel);
  const close = (focus = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    if (focus) btn.focus();
  };
  const onDoc = (e: Event) => {
    if (!(e.target instanceof Node) || !wrap.contains(e.target)) close();
  };
  btn.addEventListener('click', () => {
    if (!panel.hidden) return close();
    build(panel, () => close(true));
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    panel.querySelector<HTMLElement>('input, button')?.focus();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopPropagation();
      close(true);
    }
  });
  return wrap;
}

const ico = (inner: string) =>
  `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const I = {
  columns: ico('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
  views: ico('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
  download: ico(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  ),
};

export function enhanceTable(table: HTMLTableElement) {
  const key = table.dataset.table2 || location.pathname;
  const wrap = table.closest<HTMLElement>('.table-wrap');
  if (!wrap || wrap.previousElementSibling?.classList.contains('table-tools')) return;
  wrap.dataset.scroll = '';
  const prefs: Prefs = { hide: [], density: 'standard', ...readJson<Partial<Prefs>>(prefKey(key), {}) };

  // 列排序（服务端 / 当前页）
  const tbody = table.tBodies[0];
  const server = table.dataset.serverSort !== undefined;
  const thAt = (n: number) => table.querySelector<HTMLTableCellElement>(`thead th:nth-child(${n})`);
  const sortable = columnsOf(table).filter(
    (c) =>
      !/^(选择|操作)$/.test(c.label) &&
      c.label !== '' &&
      !table.querySelector(`thead th:nth-child(${c.n}).col-check`) &&
      (!server || !!thAt(c.n)?.dataset.sortKey),
  );
  if (server && prefs.sort && !thAt(prefs.sort.col)?.dataset.sortKey) prefs.sort = null;
  let sorting = false;
  let mo: MutationObserver | null = null;
  const sortRows = () => {
    if (!tbody || sorting || server) return;
    const rows = [...tbody.rows].filter((r) => !r.querySelector('td[colspan]'));
    if (rows.length < 2) return;
    const sort = prefs.sort;
    const keyed = rows.map((r, i) => ({ r, i, v: sort ? (r.cells[sort.col - 1]?.textContent ?? '') : '' }));
    if (sort) keyed.sort((p, q) => compareCells(p.v, q.v, sort.dir) || p.i - q.i);
    else keyed.sort((p, q) => Number(p.r.dataset.order ?? p.i) - Number(q.r.dataset.order ?? q.i));
    if (keyed.every((k, i) => rows[i] === k.r)) return;
    sorting = true;
    tbody.append(...keyed.map((k) => k.r));
    mo?.takeRecords(); // 丢掉自己这次重排产生的变动记录，免得观察者再触发一次
    sorting = false;
  };
  const markOrder = () => {
    if (!tbody || sorting) return;
    [...tbody.rows].forEach((r, i) => {
      if (r.dataset.order === undefined) r.dataset.order = String(i);
    });
  };
  for (const c of sortable) {
    const th = table.querySelector<HTMLTableCellElement>(`thead th:nth-child(${c.n})`);
    if (!th) continue;
    const btn = h('button', { type: 'button', class: 'th-sort', 'data-sort-col': String(c.n) });
    const label = h('span', { class: 'th-sort__label' });
    label.append(...th.childNodes);
    btn.append(label, h('span', { class: 'th-sort__icon', 'aria-hidden': 'true' }));
    th.append(btn);
    btn.addEventListener('click', () => {
      const cur = prefs.sort?.col === c.n ? prefs.sort.dir : null;
      setSort(
        cur === null
          ? { col: c.n, dir: 'ascending' }
          : cur === 'ascending'
            ? { col: c.n, dir: 'descending' }
            : null,
        c.n,
      );
    });
  }
  // 表头按钮与窄屏排序下拉共用：更新 prefs.sort → aria-sort / 记忆 → 服务端取数或当前页重排
  function setSort(next: Prefs['sort'], col: number) {
    prefs.sort = next;
    apply();
    if (server) {
      const key = thAt(next?.col ?? col)?.dataset.sortKey ?? '';
      table.dispatchEvent(
        new CustomEvent<ServerSort | null>('table2:sort', {
          detail: next ? { key, dir: next.dir === 'ascending' ? 'asc' : 'desc' } : null,
        }),
      );
    } else sortRows();
  }

  // 窄屏卡片（< 900，data-cards）：thead 只做视觉隐藏（列名仍供辅助技术与数据关联），
  // 其中的排序按钮 / 调宽手柄移出 Tab 顺序；排序改由工具条里可见的下拉提供，状态仍是同一个 prefs.sort。
  const cardsMq =
    table.dataset.cards !== undefined && typeof matchMedia === 'function'
      ? matchMedia('(max-width: 899.98px)')
      : null;
  let sortSel: HTMLSelectElement | null = null;
  if (cardsMq && sortable.length) {
    // 名称只取「排序」：包在 <label> 里会把全部选项文字并入可访问名称，与页面上的「状态」等筛选同名冲突
    sortSel = h('select', {
      class: 'select select--inline',
      'data-sort-select': true,
      'aria-label': '排序',
    }) as HTMLSelectElement;
    sortSel.append(h('option', { value: '', text: '默认顺序' }));
    for (const c of sortable)
      sortSel.append(
        h('option', { value: `${c.n}:ascending`, text: `${c.label} 升序` }),
        h('option', { value: `${c.n}:descending`, text: `${c.label} 降序` }),
      );
    sortSel.addEventListener('change', () => {
      const [n, dir] = sortSel!.value.split(':');
      const col = Number(n);
      setSort(sortSel!.value ? { col, dir: dir as SortDir } : null, prefs.sort?.col ?? col);
    });
  }

  // 列宽（拖动 / 键盘），记忆
  const widths = (prefs.widths ??= {});
  const setW = (th: HTMLTableCellElement, w: number | null) => {
    if (w === null) {
      th.style.removeProperty('width');
      th.style.removeProperty('min-width');
      delete widths[th.cellIndex + 1];
    } else {
      const px = Math.round(Math.min(Math.max(w, 64), 640));
      th.style.width = `${px}px`;
      th.style.minWidth = `${px}px`;
      widths[th.cellIndex + 1] = px;
    }
  };
  columnsOf(table)
    .filter(
      (c) => !/^(选择|操作)$/.test(c.label) && c.label !== '' && !thAt(c.n)?.classList.contains('col-check'),
    )
    .forEach((c) => {
      const th = thAt(c.n);
      if (!th) return;
      if (widths[c.n]) setW(th, widths[c.n]);
      const grip = h('span', {
        class: 'th-resize',
        role: 'separator',
        tabindex: '0',
        'aria-orientation': 'vertical',
        'aria-label': `调整第 ${c.n} 列宽度`,
        'aria-valuemin': '64',
        'aria-valuemax': '640',
        'aria-valuenow': String(Math.round(th.getBoundingClientRect().width) || 120),
        'data-col-resize': String(c.n),
      });
      const commit = () => {
        grip.setAttribute('aria-valuenow', String(Math.round(th.getBoundingClientRect().width)));
        writeJson(prefKey(key), prefs);
      };
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX;
        const w0 = th.getBoundingClientRect().width;
        grip.setPointerCapture(e.pointerId);
        table.dataset.resizing = '';
        const move = (ev: PointerEvent) => setW(th, w0 + ev.clientX - x0);
        const up = () => {
          grip.removeEventListener('pointermove', move);
          delete table.dataset.resizing;
          commit();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up, { once: true });
        grip.addEventListener('pointercancel', up, { once: true });
      });
      grip.addEventListener('click', (e) => e.stopPropagation());
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        setW(th, null);
        commit();
      });
      grip.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        setW(th, th.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 16 : -16));
        commit();
      });
      th.append(grip);
    });
  if (tbody) {
    mo = new MutationObserver(() => {
      markOrder();
      sortRows();
    });
    mo.observe(tbody, { childList: true });
  }
  markOrder();

  const apply = () => {
    table.querySelectorAll<HTMLTableCellElement>('thead th').forEach((th, i) => {
      if (!th.querySelector('.th-sort')) return;
      if (prefs.sort?.col === i + 1) th.setAttribute('aria-sort', prefs.sort.dir);
      else th.removeAttribute('aria-sort');
    });
    if (sortSel) sortSel.value = prefs.sort ? `${prefs.sort.col}:${prefs.sort.dir}` : '';
    table.dataset.density = prefs.density;
    const hide = prefs.hide.filter((n) => !columnsOf(table).find((c) => c.n === n)?.locked);
    if (hide.length) table.dataset.hide = hide.join(' ');
    else delete table.dataset.hide;
    seg
      .querySelectorAll('button')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.density === prefs.density)));
    writeJson(prefKey(key), prefs);
  };

  // 密度
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': '表格密度' });
  for (const [d, label] of [
    ['standard', '标准'],
    ['compact', '紧凑'],
  ] as const) {
    const b = h('button', { type: 'button', 'data-density': d, 'aria-pressed': 'false', text: label });
    b.addEventListener('click', () => {
      prefs.density = d;
      apply();
    });
    seg.append(b);
  }

  // 列管理
  const cols = popover('列', I.columns, (panel) => {
    panel.replaceChildren(h('p', { class: 'table-pop__title', text: '显示的列' }));
    for (const c of columnsOf(table).filter((x) => !x.locked)) {
      const box = h('input', { type: 'checkbox', checked: !prefs.hide.includes(c.n) }) as HTMLInputElement;
      box.addEventListener('change', () => {
        prefs.hide = box.checked ? prefs.hide.filter((n) => n !== c.n) : [...prefs.hide, c.n];
        apply();
      });
      panel.append(h('label', { class: 'check' }, box, h('span', { text: c.label })));
    }
    const reset = h('button', { type: 'button', class: 'btn btn--sm btn--text', text: '恢复默认列' });
    reset.addEventListener('click', () => {
      prefs.hide = [];
      apply();
      panel.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((b) => (b.checked = true));
    });
    panel.append(h('div', { class: 'table-pop__sep' }), reset);
  });

  // 保存视图
  const views = popover('视图', I.views, (panel, close) => {
    const list = readJson<SavedView[]>(viewKey(key), []);
    panel.replaceChildren(h('p', { class: 'table-pop__title', text: '保存的视图（仅本浏览器）' }));
    if (!list.length)
      panel.append(h('p', { class: 'table-pop__title', text: '还没有保存的视图。先筛选，再保存当前视图。' }));
    for (const v of list) {
      const go = h('button', { type: 'button', class: 'btn btn--sm btn--text', text: v.name });
      go.addEventListener('click', () => {
        prefs.hide = v.hide;
        prefs.density = v.density;
        apply();
        close();
        if (v.search !== location.search) location.assign(`${location.pathname}${v.search}`);
      });
      const del = h('button', {
        type: 'button',
        class: 'btn btn--sm btn--ghost',
        'aria-label': `删除视图：${v.name}`,
        text: '删除',
      });
      del.addEventListener('click', () => {
        writeJson(
          viewKey(key),
          readJson<SavedView[]>(viewKey(key), []).filter((x) => x.name !== v.name),
        );
        del.closest('.table-pop__row')?.remove();
      });
      panel.append(h('div', { class: 'table-pop__row' }, go, del));
    }
    const name = h('input', {
      type: 'text',
      class: 'input',
      maxlength: '24',
      placeholder: '视图名称，如「被举报的主题」',
      'aria-label': '视图名称',
    }) as HTMLInputElement;
    const save = h('button', {
      type: 'button',
      class: 'btn btn--sm btn--tonal btn--rect',
      text: '保存当前视图',
    });
    save.addEventListener('click', () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      const next = readJson<SavedView[]>(viewKey(key), []).filter((x) => x.name !== n);
      next.push({ name: n, search: location.search, hide: prefs.hide, density: prefs.density });
      writeJson(viewKey(key), next.slice(-12));
      close();
    });
    panel.append(h('div', { class: 'table-pop__sep' }), name, save);
  });

  // 导出 CSV（当前页）
  const exp = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--outline btn--rect',
    'data-export-csv': true,
  });
  exp.innerHTML = I.download;
  exp.append(document.createTextNode('导出本页 CSV'));
  exp.addEventListener('click', () => {
    const { cols: c, rows } = tableRows(table, prefs.hide);
    const objs = rows.map((r) => Object.fromEntries(c.map((k, i) => [k, r[i]])));
    download(`${key}-${stamp()}.csv`, toCsv(objs, c), 'text/csv;charset=utf-8');
  });

  // 「全选本页」（P10i r3）：表格正上方单独一行的 [data-select-all-row] 并入工具条，放在密度切换之后
  const allRow = wrap.previousElementSibling;
  const allLabel = allRow?.matches('[data-select-all-row]')
    ? allRow.querySelector<HTMLElement>('label:has(input[data-select-all])')
    : null;
  const tools = h(
    'div',
    { class: 'table-tools', role: 'group', 'aria-label': '表格工具' },
    seg,
    ...(sortSel
      ? [
          h(
            'div',
            { class: 'table-tools__sort' },
            h('span', { text: '排序', 'aria-hidden': 'true' }),
            sortSel,
          ),
        ]
      : []),
    ...(allLabel ? [allLabel] : []),
    h('span', { class: 'table-tools__spacer' }),
    cols,
    views,
    exp,
  );
  wrap.before(tools);
  if (allLabel) allRow?.remove();
  apply();
  sortRows();

  if (cardsMq) {
    // 断点交接（R12）：每张表一份焦点归属记录。只恢复「被本表窄 / 宽切换作废」的焦点：
    //  - 记录：焦点进入本表的排序下拉、表头 .th-sort / .th-resize 或工具条按钮时记下（归属 = 本表）；
    //  - 资格：按断点 + 控件角色判断（下拉只在窄屏、表头控件只在宽屏），再加 isShown 排除 display:none 的列。
    //    窄屏表头只是视觉裁切（clip-path），checkVisibility() 仍为 true，所以不能只靠它；
    //  - 采纳：初始化时焦点已在本表控件上，只在初始化时采纳一次；之后归属只由「新的 focusin 进入本表控件」或
    //    「在仍是焦点的本表合格控件上 pointerdown / keydown」重新建立。取消后旧控件即使仍是 activeElement，
    //    之后的 MQ change / resize 也不会据此恢复（取消优先，Escape 不例外）；
    //  - 触发：MQ change 同步调用 syncCards；resize 时按需合并成一个 rAF（快速 1000→800→1000 可能没有 MQ change），
    //    被隐藏控件先失焦到 BODY（relatedTarget=null）时也按需排一个 rAF。rAF 回调不看排队时的状态，
    //    执行时按最新归属重新判断（新焦点已接走 → 不动；新归属需要交接 → 照常交接；tabindex 照常同步）；
    //  - 取消：焦点进入其它控件 / 其它表、在非本表控件处（含本表空白处）pointerdown、Tab / Escape、
    //    页面失焦或隐藏、记录的控件或表格脱离文档；回到前台不自动恢复；
    //  - 不抢：页面隐藏或没有焦点、真正打开且可见的模态 / popover / 工具条弹出面板（.table-pop__panel）存在时不动；
    //    目标已是焦点时不再调用 focus()。
    const prev = handoffs.get(table);
    prev?.abort();
    const ac = new AbortController();
    handoffs.set(table, ac);
    const { signal } = ac;
    type Role = 'sort' | 'th' | 'tool';
    let owner: { el: HTMLElement; role: Role } | null = null;
    let raf = 0;
    let synced: boolean | null = null;
    const roleOf = (el: EventTarget | null): Role | null => {
      if (!(el instanceof HTMLElement)) return null;
      if (sortSel && el === sortSel) return 'sort';
      if (table.tHead?.contains(el) && el.matches('.th-sort, .th-resize')) return 'th';
      if (tools.contains(el) && el.matches('button') && !el.closest('.table-pop__panel')) return 'tool';
      return null;
    };
    // 断点 + 角色：下拉只属于窄屏，表头控件只属于宽屏；工具条按钮两种都可。另需真实渲染（排除 display:none）。
    const eligible = (el: HTMLElement | null, narrow: boolean): el is HTMLElement => {
      if (!el || !el.isConnected || !table.isConnected) return false;
      const r = roleOf(el);
      if (!r || (r === 'sort' && !narrow) || (r === 'th' && narrow)) return false;
      if (el instanceof HTMLButtonElement && el.disabled) return false;
      return isShown(el);
    };
    // 取消只放弃归属；已排队的 rAF 保留（执行时归属为空，只同步 tabindex，不动焦点）
    const cancel = () => {
      owner = null;
    };
    // 撤销旧控制器时 AbortController.abort() 不会取消已排队的 rAF，这里显式取消
    signal.addEventListener('abort', () => {
      owner = null;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    });
    const blocked = () => {
      if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) return true;
      const open = (sel: string) => {
        try {
          return [...document.querySelectorAll<HTMLElement>(sel)].some(
            (m) => isShown(m) && !m.closest('[inert]'),
          );
        } catch {
          return false; // 不支持的选择器（如旧环境的 :popover-open）
        }
      };
      // 工具条弹出面板：popover() 用 hidden 属性开关（同时切换按钮 aria-expanded），[hidden] 时 display:none。
      // 只认这个类名，不把 role=group 节点（工具条、密度切换、关闭的面板）一概当作阻挡
      const panelOpen = [...document.querySelectorAll<HTMLElement>('.table-pop__panel')].some(
        (p) => !p.hidden && isShown(p) && !p.closest('[inert]'),
      );
      return panelOpen || open('dialog[open]') || open('[aria-modal="true"]') || open(':popover-open');
    };
    const syncTabs = (narrow: boolean) => {
      if (synced === narrow) return;
      synced = narrow;
      table.querySelectorAll<HTMLElement>('thead .th-sort, thead .th-resize').forEach((el) => {
        if (narrow) el.tabIndex = -1;
        else if (el.classList.contains('th-resize')) el.tabIndex = 0;
        else el.removeAttribute('tabindex');
      });
    };
    const syncCards = () => {
      if (!table.isConnected) return teardown();
      const narrow = cardsMq.matches;
      syncTabs(narrow);
      const active = document.activeElement;
      if (!owner) return;
      if (!owner.el.isConnected) return cancel(); // 被替换 / 移除：不当作交接
      // 只处理本表窄 / 宽切换作废的焦点：下拉在宽屏、表头控件在窄屏。工具条按钮不受切换影响；
      // 同一断点下因 display:none（列被隐藏）失效的不算切换，放弃记录
      const swapped = (owner.role === 'sort' && !narrow) || (owner.role === 'th' && narrow);
      if (!swapped) {
        if (!eligible(owner.el, narrow)) cancel();
        return;
      }
      // 焦点只能在 BODY / null，或仍停在这个已作废的控件上；其它情况说明焦点已被别处接走
      if (active && active !== document.body && active !== owner.el) return cancel();
      if (blocked()) return cancel(); // 页面不在前台 / 有模态：放弃，之后也不自动恢复
      const candidates: (HTMLElement | null)[] = narrow
        ? [sortSel, ...tools.querySelectorAll<HTMLElement>('button')]
        : [
            // 对应列表头 → 其它可见表头排序按钮 → 工具条按钮；只停在真正拿到焦点的控件上
            table.querySelector<HTMLElement>(`thead [data-sort-col="${prefs.sort?.col ?? sortable[0]?.n}"]`),
            ...table.querySelectorAll<HTMLElement>('thead .th-sort'),
            ...tools.querySelectorAll<HTMLElement>('button:not([disabled])'),
          ];
      for (const el of candidates) {
        if (!eligible(el, narrow)) continue;
        if (document.activeElement !== el) el.focus();
        if (document.activeElement === el) break;
      }
    };
    const later = () => {
      if (raf) return; // 合并：同一帧只排一个
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        syncCards(); // 按执行时的最新归属与焦点重新判断，不按排队时的状态
      });
    };
    // 在仍是焦点的本表合格控件上的新交互（pointerdown / keydown）：重新建立归属
    const reconfirm = (el: Element | null) => {
      const r = roleOf(el);
      if (r && el === document.activeElement && eligible(el as HTMLElement, cardsMq.matches))
        owner = { el: el as HTMLElement, role: r };
      return r;
    };
    const teardown = () => {
      cancel();
      ac.abort();
      if (handoffs.get(table) === ac) handoffs.delete(table);
    };
    document.addEventListener(
      'focusin',
      (e) => {
        if (!table.isConnected) return teardown();
        const r = roleOf(e.target);
        if (r) owner = { el: e.target as HTMLElement, role: r };
        else cancel(); // 其它控件、行内按钮、别的表
      },
      { capture: true, signal },
    );
    document.addEventListener(
      'focusout',
      (e) => {
        if (!owner || e.target !== owner.el || (e as FocusEvent).relatedTarget) return;
        // 失焦到 BODY：只有控件已不再渲染或不再属于当前断点（被本表切换隐藏）才保留记录并按需排一个 rAF
        if (!owner.el.isConnected) return cancel();
        if (!isShown(owner.el) || !eligible(owner.el, cardsMq.matches)) later();
        else cancel();
      },
      { capture: true, signal },
    );
    document.addEventListener(
      'pointerdown',
      (e) => {
        // 本表合格控件上：若它仍是焦点则重新建立归属，否则等随后的 focusin；其它地方（含空白）取消
        if (!reconfirm(e.target instanceof Element ? e.target.closest('button, select, .th-resize') : null))
          cancel();
      },
      { capture: true, signal },
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Tab' || e.key === 'Escape') cancel();
        else reconfirm(e.target instanceof Element ? e.target : null);
      },
      { capture: true, signal },
    );
    // 页面隐藏 / 窗口失焦：放弃记录，回到前台不自动恢复
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) cancel();
      },
      { signal },
    );
    window.addEventListener(
      'blur',
      (e) => {
        // 只认窗口自身的 blur（非捕获监听只在目标阶段触发）；不与全局 window 做身份比较（jsdom 测试环境里两者不是同一对象）
        if (e.target === e.currentTarget) cancel();
      },
      { signal },
    );
    window.addEventListener(
      'resize',
      () => {
        if (!table.isConnected) return teardown();
        if (owner || synced !== cardsMq.matches) later(); // 按需：没有记录且断点未变时不排 rAF
      },
      { passive: true, signal },
    );
    cardsMq.addEventListener('change', syncCards, { signal });
    // 初始化时采纳一次已有焦点（等价于原来的 active in thead / active === sortSel 分支）；之后不再采纳
    const initial = document.activeElement;
    const initialRole = roleOf(initial);
    if (initialRole) owner = { el: initial as HTMLElement, role: initialRole };
    syncCards();
  }
}

export function enhanceTables(root: ParentNode = document) {
  root.querySelectorAll<HTMLTableElement>('table.data-table[data-table2]').forEach(enhanceTable);
}
