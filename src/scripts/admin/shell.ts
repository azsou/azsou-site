/**
 * 后台共用：权限门、仓储、分页、URL 筛选状态、表单对话框、多选。
 * 界面上的权限判断只为体验；每个写操作都由数据库再校验一次。
 */
import { getRepository, type AdminRepo, type Profile } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';
import { url } from '@/lib/routes';
import { h, viewer } from '../community/ui';

export { h };

const root = () => document.querySelector<HTMLElement>('[data-admin]')!;

export function adminRepo(): AdminRepo {
  const a = getRepository().admin;
  if (!a) throw new Error('当前数据适配器不支持管理后台');
  return a;
}

export const isAdminRole = (p: Profile | null) => !!p && !p.banned && p.role === 'admin';
export const isModRole = (p: Profile | null) =>
  !!p && !p.banned && (p.role === 'admin' || p.role === 'moderator');

/** 权限门：未登录 → 登录引导；角色不够 → 无权限；通过 → 显示内容并返回当前用户 */
export async function initAdmin(): Promise<Profile | null> {
  const el = root();
  const need = el.dataset.require === 'admin' ? 'admin' : 'moderator';
  const gate = el.querySelector<HTMLElement>('[data-admin-gate]')!;
  const status = gate.querySelector<HTMLElement>('[data-gate-status]')!;
  const me = await viewer();
  if (!me) {
    status.hidden = true;
    gate.querySelector<HTMLAnchorElement>('[data-gate-login]')!.href = url.login(
      location.pathname + location.search,
    );
    gate.querySelector<HTMLElement>('[data-gate-signed-out]')!.hidden = false;
    return null;
  }
  const ok = need === 'admin' ? isAdminRole(me) : isModRole(me);
  if (isAdminRole(me))
    el.querySelectorAll<HTMLElement>('[data-nav-role="admin"]').forEach((x) => (x.hidden = false));
  if (!ok) {
    status.hidden = true;
    const text = gate.querySelector<HTMLElement>('[data-gate-forbidden-text]')!;
    if (need === 'admin' && isModRole(me)) text.textContent = '这个页面仅管理员可用。';
    else if (me.banned) text.textContent = '你的账号已被限制，暂时不能使用管理后台。';
    gate.querySelector<HTMLElement>('[data-gate-forbidden]')!.hidden = false;
    return null;
  }
  gate.hidden = true;
  el.querySelector<HTMLElement>('[data-admin-body]')!.hidden = false;
  void refreshOpenCount();
  return me;
}

/** 侧栏「举报队列」的待处理数 */
export async function refreshOpenCount() {
  const badge = root()?.querySelector<HTMLElement>('[data-open-count]');
  if (!badge) return;
  try {
    const { total } = await adminRepo().listReports({ status: 'open', limit: 1 });
    badge.hidden = !total;
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.setAttribute('aria-label', `${total} 条待处理`);
  } catch {
    badge.hidden = true;
  }
}

export function setStatusText(el: HTMLElement | null, text: string, kind: 'info' | 'error' = 'info') {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('notice', kind === 'error');
  el.classList.toggle('notice--error', kind === 'error');
}
export const errorText = (e: unknown, fallback = '加载失败，请稍后再试。') => friendlyError(e, fallback);

// ------------------------------------------------------------ URL 状态 ------
export function readParams<T extends Record<string, string>>(defaults: T): T {
  const p = new URLSearchParams(location.search);
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const v = p.get(k);
    if (v !== null) (out as Record<string, string>)[k] = v;
  }
  return out;
}
export function writeParams(state: Record<string, string>, defaults: Record<string, string>) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(state)) {
    if (v === '' || v === defaults[k]) p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
}

// --------------------------------------------------------------- 分页 -------
export function renderPagination(
  el: HTMLElement,
  opts: { offset: number; limit: number; total: number; onChange: (offset: number) => void },
) {
  const { offset, limit, total } = opts;
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  const prev = h('button', { type: 'button', class: 'btn btn--sm', text: '上一页', disabled: offset <= 0 });
  const next = h('button', { type: 'button', class: 'btn btn--sm', text: '下一页', disabled: to >= total });
  prev.addEventListener('click', () => opts.onChange(Math.max(0, offset - limit)));
  next.addEventListener('click', () => opts.onChange(offset + limit));
  el.replaceChildren(
    h('span', { 'aria-live': 'polite', text: total ? `第 ${from}–${to} 条，共 ${total} 条` : '没有记录' }),
    h('span', { class: 'btn-row' }, prev, next),
  );
}

// --------------------------------------------------------------- 多选 -------
export interface Selection {
  ids(): string[];
  clear(): void;
  /** 每次渲染新行后调用 */
  bind(): void;
}
/**
 * 行内 `input[data-select]`（value=id）+ 「全选本页」`input[data-select-all]`；
 * 选中行加 data-selected（只是样式；复选框本身已表达选中状态），批量操作条显示已选数量。
 */
export function createSelection(
  scope: HTMLElement,
  bar: HTMLElement | null,
  onChange?: (n: number) => void,
): Selection {
  const boxes = () => [...scope.querySelectorAll<HTMLInputElement>('input[data-select]')];
  const all = () => scope.querySelector<HTMLInputElement>('input[data-select-all]');
  const paint = () => {
    const list = boxes();
    const n = list.filter((b) => b.checked).length;
    for (const b of list) b.closest('[data-row]')?.setAttribute('data-selected', String(b.checked));
    const a = all();
    if (a) {
      a.checked = n > 0 && n === list.length;
      a.indeterminate = n > 0 && n < list.length;
    }
    if (bar) {
      bar.hidden = n === 0;
      const c = bar.querySelector<HTMLElement>('[data-selected-count]');
      if (c) c.textContent = `已选 ${n} 项`;
    }
    onChange?.(n);
  };
  scope.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.matches('input[data-select-all]')) boxes().forEach((b) => (b.checked = t.checked));
    if (t.matches('input[data-select], input[data-select-all]')) paint();
  });
  return {
    ids: () =>
      boxes()
        .filter((b) => b.checked)
        .map((b) => b.value),
    clear: () => {
      boxes().forEach((b) => (b.checked = false));
      paint();
    },
    bind: paint,
  };
}

// ------------------------------------------------------------- 对话框 -------
let dialogSeq = 0;
/**
 * 表单对话框（原生 <dialog> showModal：焦点被限制在对话框内，Esc 关闭）。
 * validate 返回错误文字则不关闭；返回 null 表示通过，resolve 表单。
 */
export function formDialog(opts: {
  title: string;
  body: (Node | string)[];
  submit: string;
  danger?: boolean;
  validate?: (form: HTMLFormElement) => string | null;
  run?: (form: HTMLFormElement) => Promise<void>;
}): Promise<HTMLFormElement | null> {
  return new Promise((resolve) => {
    const id = `adlg-${++dialogSeq}`;
    const status = h('p', { class: 'notice notice--error form-status', role: 'alert', hidden: true });
    const submit = h('button', {
      type: 'submit',
      class: `btn ${opts.danger ? 'btn--danger' : 'btn--primary'}`,
      text: opts.submit,
    });
    const cancel = h('button', { type: 'button', class: 'btn', text: '取消' });
    const form = h(
      'form',
      { class: 'form', method: 'dialog', novalidate: true },
      ...opts.body,
      status,
      h('div', { class: 'btn-row sheet__actions' }, cancel, submit),
    );
    const d = h(
      'dialog',
      { class: 'sheet', 'aria-labelledby': id },
      h('h2', { id, class: 'sheet__title', text: opts.title }),
      form,
    );
    let result: HTMLFormElement | null = null;
    d.addEventListener('close', () => {
      setTimeout(() => d.remove(), 0);
      resolve(result);
    });
    cancel.addEventListener('click', () => d.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = opts.validate?.(form) ?? null;
      if (err) {
        status.textContent = err;
        status.hidden = false;
        return;
      }
      if (opts.run) {
        submit.disabled = true;
        submit.setAttribute('aria-busy', 'true');
        try {
          await opts.run(form);
        } catch (er) {
          status.textContent = friendlyError(er);
          status.hidden = false;
          submit.disabled = false;
          submit.removeAttribute('aria-busy');
          return;
        }
      }
      result = form;
      d.close();
    });
    document.body.append(d);
    d.showModal();
    (form.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? cancel).focus();
  });
}

/** 带 label 的表单字段 */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  const hintEl = hint ? h('p', { class: 'field__hint', id: `${id}-hint`, text: hint }) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, hintEl);
}

export function select(name: string, options: [string, string][], value = ''): HTMLSelectElement {
  const s = h('select', { name });
  for (const [v, label] of options) s.append(h('option', { value: v, text: label, selected: v === value }));
  return s;
}

/** 本地时间显示（上海时区） */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace(/\//g, '-');
}

export function banText(u: { banned: boolean; banExpiresAt: string | null }) {
  if (!u.banned) return '';
  return u.banExpiresAt ? `封禁至 ${dateTime(u.banExpiresAt)}` : '永久封禁';
}

export const ROLE_LABEL: Record<string, string> = { user: '用户', moderator: '版主', admin: '管理员' };

/** 下载文本文件（导出 JSON / CSV） */
export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
