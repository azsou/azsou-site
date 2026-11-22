/**
 * 后台数据表（T9.16，DESIGN-SYSTEM §14）：加载骨架 / 空态 / 错误态（含重试）/ 行操作「⋯」菜单 / 摘要纯文本。
 *
 * 列优先级（data-priority，写在 th 与 td 上）：
 *  - 不写 = 必显（复选、主列、操作）；
 *  - "2" = 次要：宽屏为普通列，窄屏（< 900）卡片里作为 meta 一行显示（不带「标签：」前缀）；
 *  - "3" = 可省：< 1200 隐藏（窄屏卡片也不显示），完整信息在详情 / 菜单里。
 * 窄屏卡片 = 主列 + 最多 2 个 meta + 操作（快捷按钮 + ⋯），不再把每一列竖排成「标签：值」。
 */
import { describeAdminError } from '@/lib/admin-errors';
import { h } from '../community/ui';

const SVG = (inner: string, size = 20) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const ICONS = {
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
} as const;

export function icon(name: keyof typeof ICONS, size = 20): HTMLElement {
  const s = h('span', { class: 'ad-icon' });
  s.innerHTML = SVG(ICONS[name], size);
  return s;
}

/** Markdown / HTML → 一行纯文本（摘要列用；DESIGN-AUDIT P1-10「Markdown 源码直出」） */
export function plainText(md: string | null | undefined, max = 120): string {
  const s = String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(\S[^*_~]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const fullRow = (cols: number, cls: string, ...kids: (Node | string | null)[]) =>
  h('tr', { class: `no-check ${cls}` }, h('td', { colspan: String(cols) }, ...kids));

/** 加载态：骨架行（视觉占位，读屏只读状态文字） */
export function showLoading(tbody: HTMLElement, cols: number, n = 5) {
  tbody.setAttribute('aria-busy', 'true');
  const rows = Array.from({ length: n }, () =>
    h(
      'tr',
      { class: 'no-check table-skel', 'aria-hidden': 'true' },
      h(
        'td',
        { colspan: String(cols) },
        h('span', { class: 'skeleton skeleton--icon' }),
        h(
          'span',
          { class: 'table-skel__lines' },
          h('span', { class: 'skeleton skeleton--title' }),
          h('span', { class: 'skeleton skeleton--text' }),
        ),
      ),
    ),
  );
  tbody.replaceChildren(...rows);
}

export interface StateAction {
  label: string;
  run: () => void;
}

/** 空态（区分「本来就没有」与「筛选后没有」：后者给「清除筛选」） */
export function showEmpty(
  tbody: HTMLElement,
  cols: number,
  opts: { title: string; text?: string; action?: StateAction; filtered?: boolean },
) {
  tbody.removeAttribute('aria-busy');
  const btn = opts.action
    ? h('button', { type: 'button', class: 'btn btn--sm', text: opts.action.label })
    : null;
  btn?.addEventListener('click', opts.action!.run);
  tbody.replaceChildren(
    fullRow(
      cols,
      'table-state',
      h(
        'div',
        { class: 'empty-state empty-state--admin', 'data-table-empty': true },
        icon(opts.filtered ? 'search' : 'inbox', 32),
        h('p', { class: 'empty-state__title', text: opts.title }),
        opts.text ? h('p', { class: 'empty-state__text', text: opts.text }) : null,
        btn,
      ),
    ),
  );
}

/**
 * 错误内容（A15）：传入错误对象时按原因分类（缺迁移 / 网络 / 超时 / 5xx / 权限），
 * 标题 + 说明 + data-error-kind；只传字符串时保持旧的单行样式。
 */
function errorBody(err: unknown, retryLabel?: string) {
  if (typeof err === 'string')
    return {
      kind: '',
      nodes: [h('span', { class: 'error-bar__text', text: err })],
      label: retryLabel ?? '重试',
    };
  const i = describeAdminError(err);
  return {
    kind: i.kind,
    nodes: [
      h(
        'span',
        { class: 'error-bar__text' },
        h('strong', { class: 'error-bar__title', text: i.title }),
        h('span', { text: ` ${i.text}` }),
      ),
    ],
    label: retryLabel ?? i.retryLabel,
  };
}

/** 错误态：原因 + 重试（不清空筛选）；retry 会真的重新请求 */
export function showError(tbody: HTMLElement, cols: number, err: unknown, retry: () => void) {
  tbody.removeAttribute('aria-busy');
  const b = errorBody(err);
  const btn = h('button', { type: 'button', class: 'btn btn--sm', text: b.label, 'data-retry': true });
  btn.addEventListener('click', retry);
  tbody.replaceChildren(
    fullRow(
      cols,
      'table-state',
      h(
        'div',
        {
          class: 'error-bar error-bar--admin',
          role: 'alert',
          'data-table-error': true,
          'data-error-kind': b.kind || undefined,
        },
        icon('alert'),
        ...b.nodes,
        btn,
      ),
    ),
  );
}

/** 列表区块（非表格，如举报卡片列表、仪表盘）用同一套空 / 错 / 加载块 */
export function stateBlock(
  kind: 'loading' | 'empty' | 'error',
  opts: { title?: string; text?: string; retry?: () => void; error?: unknown } = {},
): HTMLElement {
  if (kind === 'loading')
    return h(
      'div',
      { class: 'state-block', 'aria-hidden': 'true' },
      ...Array.from({ length: 3 }, () => h('span', { class: 'skeleton skeleton--card' })),
    );
  if (kind === 'empty')
    return h(
      'div',
      { class: 'empty-state empty-state--admin', 'data-table-empty': true },
      icon('inbox', 32),
      h('p', { class: 'empty-state__title', text: opts.title ?? '这里还没有内容' }),
      opts.text ? h('p', { class: 'empty-state__text', text: opts.text }) : null,
    );
  const b = errorBody(opts.error !== undefined ? opts.error : (opts.text ?? '加载失败，请稍后再试。'));
  const btn = h('button', { type: 'button', class: 'btn btn--sm', text: b.label, 'data-retry': true });
  if (opts.retry) btn.addEventListener('click', opts.retry);
  return h(
    'div',
    {
      class: 'error-bar error-bar--admin',
      role: 'alert',
      'data-table-error': true,
      'data-error-kind': b.kind || undefined,
    },
    icon('alert'),
    ...b.nodes,
    opts.retry ? btn : null,
  );
}

// ------------------------------------------------------------ 行操作菜单 ----
export interface MenuItem {
  label: string;
  run: () => unknown;
  danger?: boolean;
  hidden?: boolean;
}

let menuSeq = 0;
let openMenu: { close: (focus?: boolean) => void } | null = null;

/**
 * 「⋯」行操作菜单（APG Menu Button）：button[aria-haspopup=menu] + role=menu 弹层。
 * ↑ / ↓ / Home / End 移动，Enter / 空格执行，Esc 关闭并把焦点还给按钮，Tab / 点外部关闭。
 * 弹层用 position: fixed 定位到按钮下方（避开表格容器的 overflow 裁切）。
 */
export function rowMenu(name: string, items: MenuItem[]): HTMLElement {
  const id = `rowmenu-${++menuSeq}`;
  const btn = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--icon row-menu__btn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': id,
    'aria-label': '更多操作',
    title: `更多操作：${name}`,
  });
  btn.innerHTML = SVG(ICONS.more);
  const list = h('div', {
    class: 'row-menu glass',
    role: 'menu',
    id,
    'aria-label': `操作：${name}`,
    hidden: true,
  });
  const visible = items.filter((i) => !i.hidden);
  const entries = visible.map((it) => {
    const b = h('button', {
      type: 'button',
      role: 'menuitem',
      tabindex: '-1',
      class: it.danger ? 'row-menu__item row-menu__item--danger' : 'row-menu__item',
      text: it.label,
    });
    b.addEventListener('click', () => {
      close(true);
      void it.run();
    });
    return b;
  });
  list.append(...entries);

  const place = () => {
    const r = btn.getBoundingClientRect();
    const w = list.offsetWidth || 180;
    const hgt = list.offsetHeight || 0;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 4;
    const top = below + hgt > window.innerHeight - 8 && r.top - hgt - 4 > 8 ? r.top - hgt - 4 : below;
    list.style.left = `${left}px`;
    list.style.top = `${top}px`;
  };
  const onDoc = (e: Event) => {
    if (!(e.target instanceof Node) || (!list.contains(e.target) && !btn.contains(e.target))) close(false);
  };
  const onScroll = () => close(false);
  function close(focus = false) {
    if (list.hidden) return;
    list.hidden = true;
    wrap.append(list);
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    if (openMenu?.close === close) openMenu = null;
    if (focus) btn.focus();
  }
  function open(at: 'first' | 'last' = 'first') {
    openMenu?.close(false);
    // 弹层挂到 body（或所在的模态 dialog）：吸顶 / 固定列单元格与 isolation 会形成层叠上下文，
    // 留在单元格里时 z-index 再高也会被表格后面的分页条盖住
    (btn.closest('dialog') ?? document.body).append(list);
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    openMenu = { close };
    document.addEventListener('pointerdown', onDoc, true);
    entries[at === 'first' ? 0 : entries.length - 1]?.focus({ preventScroll: true });
    // 滚动 / 缩放关闭从下一帧开始监听：WebKit 移动端聚焦菜单项时可能触发一次滚动，不能把刚打开的菜单关掉
    requestAnimationFrame(() => {
      if (list.hidden) return;
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
    });
  }
  btn.addEventListener('click', () => (list.hidden ? open() : close(true)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open(e.key === 'ArrowUp' ? 'last' : 'first');
    }
  });
  list.addEventListener('keydown', (e) => {
    const i = entries.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => entries[(n + entries.length) % entries.length]?.focus({ preventScroll: true });
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(entries.length - 1);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') {
      // 弹层在 DOM 末尾：先把焦点还给按钮，默认 Tab 再从按钮往后走
      btn.focus({ preventScroll: true });
      close(false);
    } else return;
    if (e.key !== 'Tab') e.preventDefault();
  });
  const wrap = h('span', { class: 'row-menu__wrap' }, btn, list);
  return wrap;
}

/** 操作列：1 个最常用的快捷按钮 + 「⋯」菜单 */
export function actionsCell(quick: HTMLElement | null, menu: HTMLElement | null): HTMLElement {
  return h('td', { class: 'col-actions' }, h('div', { class: 'row-actions' }, quick, menu));
}
