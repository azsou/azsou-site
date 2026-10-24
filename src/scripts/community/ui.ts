/**
 * 社区 island 共用的 DOM 工具：元素构造、提示条（toast）、确认框、举报框、登录引导。
 * 用户内容只经 textContent 或 sanitize() 之后的 HTML 进入页面。
 */
import { url } from '@/lib/routes';
import { getRepository, type Profile, type ReportReason, type ReportTarget } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

// ------------------------------------------------------------- viewer ------
let viewerPromise: Promise<Profile | null> | null = null;
/** 当前登录用户的资料（含角色）；未登录为 null。每页只请求一次。 */
export function viewer(): Promise<Profile | null> {
  if (!viewerPromise) {
    const repo = getRepository();
    viewerPromise = repo.auth.getSession()
      ? repo.profiles
          .me()
          .then((p) => {
            syncProfileCache(p);
            return p;
          })
          .catch(() => null)
      : Promise.resolve(null);
  }
  return viewerPromise;
}

/**
 * 顶栏菜单只读本地缓存的角色（不发请求）；拿到最新资料时顺手更新缓存，
 * 这样被提升 / 撤销版主的用户不用重新登录，「管理后台」入口就会跟着变。
 */
function syncProfileCache(p: Profile | null) {
  if (!p) return;
  try {
    const KEY = 'az-profile-v2';
    const next = { id: p.id, displayName: p.displayName, role: p.banned ? 'user' : p.role };
    const cur = localStorage.getItem(KEY);
    if (cur === JSON.stringify(next)) return;
    localStorage.setItem(KEY, JSON.stringify(next));
    dispatchEvent(new CustomEvent('az:auth'));
  } catch {
    /* 隐私模式 */
  }
}
export const isMod = (p: Profile | null) =>
  !!p && !p.banned && (p.role === 'moderator' || p.role === 'admin');
export const roleLabel = (p: { role?: string } | null) =>
  p?.role === 'admin' ? '管理员' : p?.role === 'moderator' ? '版主' : '';

export function loginPrompt(text = '登录后参与讨论。'): HTMLElement {
  const next = location.pathname + location.search;
  return h(
    'div',
    { class: 'composer-gate' },
    h('p', { text }),
    h(
      'div',
      { class: 'btn-row' },
      h('a', { class: 'btn btn--primary', href: url.login(next), text: '登录' }),
      h('a', { class: 'btn', href: '/register/', text: '注册' }),
    ),
  );
}

// -------------------------------------------------------------- toast ------
let toastBox: HTMLElement | null = null;
export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('p', { class: `toast toast--${kind}`, text });
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000);
}
export const toastError = (e: unknown, fallback?: string) => toast(friendlyError(e, fallback), 'error');

/** 按钮执行期间置为忙碌，防止重复提交 */
export async function busy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T> {
  if (btn) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }
}

// ------------------------------------------------------------- dialog ------
function modal(title: string, body: Node, actions: HTMLElement): HTMLDialogElement {
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const d = h(
    'dialog',
    { class: 'sheet', 'aria-labelledby': id },
    h('h2', { id, class: 'sheet__title', text: title }),
    body,
    actions,
  );
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
  document.body.append(d);
  d.showModal();
  return d;
}

/** 确认框（替代 window.confirm，可访问、可测试） */
export function confirmDialog(message: string, ok = '确定', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const yes = h('button', {
      type: 'button',
      class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
      text: ok,
    });
    const no = h('button', { type: 'button', class: 'btn', text: '取消' });
    const d = modal(message, h('span'), h('div', { class: 'btn-row sheet__actions' }, no, yes));
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
      d.close();
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    d.addEventListener('close', () => finish(false));
    no.focus();
  });
}

export const REPORT_REASONS: [ReportReason, string][] = [
  ['spam', '垃圾广告 / 引流'],
  ['abuse', '辱骂、骚扰或人身攻击'],
  ['illegal', '违法违规内容'],
  ['privacy', '泄露他人隐私'],
  ['other', '其他'],
];

/** 举报框：选原因 + 可选说明 → reports 表 */
export function reportDialog(targetType: ReportTarget, targetId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const uid = Math.random().toString(36).slice(2, 8);
    const fieldset = h(
      'fieldset',
      { class: 'choice-list' },
      h('legend', { class: 'visually-hidden', text: '举报原因' }),
      ...REPORT_REASONS.map(([value, label], i) =>
        h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: `reason-${uid}`, value, checked: i === 0 }),
          h('span', { text: label }),
        ),
      ),
    );
    const detail = h('textarea', {
      id: `detail-${uid}`,
      rows: '3',
      maxlength: '500',
      placeholder: '补充说明（选填，最多 500 字）',
    });
    const status = h('p', { class: 'notice notice--error form-status', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', text: '提交举报' });
    const cancel = h('button', { type: 'button', class: 'btn', text: '取消' });
    const form = h(
      'form',
      { class: 'form', method: 'dialog' },
      fieldset,
      h('div', { class: 'field' }, h('label', { for: `detail-${uid}`, text: '补充说明' }), detail),
      status,
      h('div', { class: 'btn-row sheet__actions' }, cancel, submit),
    );
    const d = modal('举报这条内容', form, h('span'));
    let sent = false;
    cancel.addEventListener('click', () => d.close());
    d.addEventListener('close', () => resolve(sent));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const reason = (form.querySelector<HTMLInputElement>('input[type=radio]:checked')?.value ??
        'other') as ReportReason;
      if ([...detail.value.trim()].length > 500) {
        status.textContent = '补充说明最多 500 个字符。';
        return;
      }
      status.textContent = '';
      try {
        await busy(submit, () =>
          getRepository().reports.create({ targetType, targetId, reason, detail: detail.value }),
        );
        sent = true;
        d.close();
        toast('已收到举报，版主会尽快处理。');
      } catch (err) {
        status.textContent = friendlyError(err).replace('你已经提交过了', '你已经举报过这条内容，正在处理中');
      }
    });
  });
}

// ------------------------------------------------------------- format ------
export function fullTime(iso: string): string {
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
  }).format(d);
}

/** 「3 分钟前」式相对时间；超过 7 天显示日期 */
export function relTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
  return fullTime(iso).slice(0, 10).replace(/\//g, '-');
}

export function timeEl(iso: string): HTMLTimeElement {
  const t = h('time', { datetime: iso, title: fullTime(iso), text: relTime(iso) });
  return t;
}
