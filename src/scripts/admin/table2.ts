/**
 * 数据表 2.0（P10h T10.17）：给 `table.data-table[data-table2="<key>"]` 加工具条——
 *  - 密度：标准 52 / 紧凑 40（记忆到 localStorage）；
 *  - 列管理：勾选显示 / 隐藏列（主列、复选、操作列不能隐藏），记忆；
 *  - 保存视图：当前筛选（URL 查询串）+ 隐藏列 + 密度存成命名视图，一键切换 / 删除（只存在本浏览器）；
 *  - 导出 CSV：导出当前页可见列（服务端分页：每页由各页面脚本向数据库按 offset / limit 拉取）。
 * 吸顶表头 + 固定首列 / 操作列由 admin.css 的 [data-table2] 规则完成（.table-wrap[data-scroll] 自己滚动）。
 * 无内联样式：隐藏列写成 table[data-hide="3 5"]，CSS 按列序号隐藏。
 */
import { toCsv } from '@/lib/csv';
import { download, h, stamp } from './shell';

export type Density = 'standard' | 'compact';
export interface SavedView {
  name: string;
  search: string;
  hide: number[];
  density: Density;
}
interface Prefs {
  hide: number[];
  density: Density;
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

  const apply = () => {
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

  const tools = h(
    'div',
    { class: 'table-tools', role: 'group', 'aria-label': '表格工具' },
    seg,
    h('span', { class: 'table-tools__spacer' }),
    cols,
    views,
    exp,
  );
  wrap.before(tools);
  apply();
}

export function enhanceTables(root: ParentNode = document) {
  root.querySelectorAll<HTMLTableElement>('table.data-table[data-table2]').forEach(enhanceTable);
}
