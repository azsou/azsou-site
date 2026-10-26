/**
 * 后台工作台交互（P10h T10.16 / T10.23）：侧栏折叠、⌘K 命令面板、键盘快捷键（j / k / x / e / / / ?）与帮助面板。
 * 由 shell.ts 引入，所有后台页面共用；不依赖权限结果（命令面板里的仅管理员页面在 initAdmin 判定后才显示）。
 * 无内联样式：状态都写成 data-* / class，由 admin.css 渲染。
 */
import { isTypingTarget, shortcutAction } from '@/lib/admin-shortcuts';

const NAV_KEY = 'az-admin-nav';
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);

// ---------------------------------------------------------------- 侧栏折叠 ----
function initNavToggle() {
  const shell = $('[data-admin]');
  const btn = $<HTMLButtonElement>('[data-nav-toggle]');
  if (!shell || !btn) return;
  const apply = (collapsed: boolean) => {
    shell.toggleAttribute('data-nav-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  };
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(NAV_KEY) === 'collapsed';
  } catch {
    /* 隐私模式：不记忆 */
  }
  apply(collapsed);
  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem(NAV_KEY, collapsed ? 'collapsed' : 'open');
    } catch {
      /* ignore */
    }
  });
}

// --------------------------------------------------------------- 命令面板 ----
interface DynItem {
  id: string;
  label: string;
  hint: string;
  href: string;
}

function initPalette() {
  const dlg = $<HTMLDialogElement>('[data-palette]');
  const input = $<HTMLInputElement>('[data-palette-input]');
  const list = $<HTMLUListElement>('[data-palette-list]');
  const empty = $('[data-palette-empty]');
  if (!dlg || !input || !list) return;
  // 与前台搜索面板一致：静态 HTML 保持 html-validate 友好，运行时再升级为 combobox
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  const staticItems = [...list.querySelectorAll<HTMLLIElement>('[data-palette-item]')];
  let active = -1;

  const canSee = (li: HTMLElement) =>
    li.dataset.needRole !== 'admin' || !!document.querySelector('[data-nav-role="admin"]:not([hidden])');

  /** 关键词搜索的动态项：搜用户 / 搜内容（走各页已有的 ?q= 筛选，服务端分页） */
  const dynamic = (q: string): DynItem[] =>
    q
      ? [
          {
            id: 'pal-q-users',
            label: `在用户里搜索「${q}」`,
            hint: '用户',
            href: `/admin/users/?q=${encodeURIComponent(q)}`,
          },
          {
            id: 'pal-q-content',
            label: `在内容里搜索「${q}」`,
            hint: '内容',
            href: `/admin/content/?q=${encodeURIComponent(q)}`,
          },
        ]
      : [];

  const visible = () => [...list.querySelectorAll<HTMLLIElement>('[role="option"]:not([hidden])')];
  const setActive = (i: number) => {
    const opts = visible();
    if (!opts.length) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    active = (i + opts.length) % opts.length;
    opts.forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  };

  const render = () => {
    const q = input.value.trim();
    const needle = q.toLowerCase();
    let shown = 0;
    for (const li of staticItems) {
      const hit = canSee(li) && (!needle || (li.dataset.keywords ?? '').toLowerCase().includes(needle));
      li.hidden = !hit;
      if (hit) shown++;
    }
    list.querySelectorAll('[data-palette-dyn]').forEach((n) => n.remove());
    for (const d of dynamic(q)) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.id = d.id;
      li.dataset.paletteDyn = '';
      li.dataset.href = d.href;
      const a = document.createElement('span');
      a.textContent = d.label;
      const hint = document.createElement('span');
      hint.className = 'palette__hint';
      hint.textContent = d.hint;
      li.append(a, hint);
      list.append(li);
      shown++;
    }
    if (empty) empty.hidden = shown > 0;
    setActive(0);
  };

  const go = (li: HTMLElement | undefined) => {
    const href = li?.dataset.href;
    if (!href) return;
    dlg.close();
    location.assign(href);
  };

  const open = () => {
    if (dlg.open) return;
    input.value = '';
    render();
    dlg.showModal();
    input.focus();
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(visible()[active]);
    }
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (li) go(li);
  });
  // 点对话框外的遮罩关闭
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.querySelectorAll('[data-admin-palette-open]').forEach((b) => b.addEventListener('click', open));
  return { open };
}

// ------------------------------------------------------------- 快捷键帮助 ----
function initHelp() {
  const dlg = $<HTMLDialogElement>('[data-shortcuts]');
  if (!dlg) return null;
  const open = () => {
    if (!dlg.open) dlg.showModal();
  };
  document.querySelectorAll('[data-shortcuts-open]').forEach((b) => b.addEventListener('click', open));
  $('[data-shortcuts-close]', dlg)?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  return { open };
}

// ---------------------------------------------------------- 表格行快捷键 ----
const rows = () =>
  [...document.querySelectorAll<HTMLTableRowElement>('[data-rows] > tr[data-row]')].filter(
    (r) => r.offsetParent !== null,
  );
const current = () => document.activeElement?.closest<HTMLTableRowElement>('[data-rows] > tr[data-row]');
const rowTarget = (r: HTMLElement) =>
  r.querySelector<HTMLElement>('.cell-title, .cell-main a, a[href], button:not([disabled])');

function moveRow(step: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  const cur = current();
  const i = cur ? list.indexOf(cur) : -1;
  const next = list[Math.min(list.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
  list.forEach((r) => r.toggleAttribute('data-kbd-active', r === next));
  rowTarget(next)?.focus();
}

function selectRow() {
  const r = current();
  const box = r?.querySelector<HTMLInputElement>('input[data-select]');
  if (!box) return;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

function openRow() {
  const r = current();
  if (!r) return;
  const t = r.querySelector<HTMLElement>('[data-preview], [data-edit]') ?? rowTarget(r);
  t?.click();
}

function focusSearch(palette: { open(): void } | undefined) {
  const s = document.querySelector<HTMLInputElement>(
    '[data-admin-body] form input[type="search"], [data-admin-body] input[type="search"]',
  );
  if (s && s.offsetParent !== null) {
    s.focus();
    s.select();
  } else palette?.open();
}

function initShortcuts(palette: { open(): void } | undefined, help: { open(): void } | null) {
  document.addEventListener('keydown', (e) => {
    const act = shortcutAction(e);
    if (!act) return;
    if (act === 'palette') {
      // 后台用自己的命令面板：拦下冒泡，不再打开前台的站内搜索面板（site-shell 监听在 window 上）
      e.preventDefault();
      e.stopPropagation();
      palette?.open();
      return;
    }
    // 单键：输入中、对话框打开时不处理
    if (isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
    const handlers: Record<string, () => void> = {
      search: () => focusSearch(palette),
      next: () => moveRow(1),
      prev: () => moveRow(-1),
      select: selectRow,
      open: openRow,
      help: () => help?.open(),
    };
    e.preventDefault();
    handlers[act]?.();
  });
}

function initKbdLabel() {
  if (/Mac|iPhone|iPad/.test(navigator.platform))
    document.querySelectorAll('[data-kbd-mod]').forEach((k) => (k.textContent = '⌘'));
}

let started = false;
export function initWorkbench() {
  if (started || !document.querySelector('[data-admin]')) return;
  started = true;
  initKbdLabel();
  initNavToggle();
  const palette = initPalette();
  const help = initHelp();
  initShortcuts(palette, help);
}
