/**
 * 顶栏用户菜单：只读 localStorage 里的会话（与 V72 共用 az-session-v68），不发请求、不引数据层，
 * 保证每一页的首屏 JS 很小；退出登录时才动态加载数据层。
 */
import { initials } from './render';

export const PROFILE_KEY = 'az-profile-v2';
const SESSION_KEY = 'az-session-v68';

interface Viewer {
  id: string;
  name: string;
  email: string;
  /** 登录时缓存的角色（只用于显示「管理后台」入口；权限由数据库判定） */
  role: string;
}

export function readViewer(): Viewer | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (!s?.access_token || !s.user?.id) return null;
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null');
    const meta = s.user.user_metadata ?? {};
    const email: string = s.user.email ?? '';
    const name: string =
      (p?.id === s.user.id && p.displayName) ||
      s.profile?.display_name ||
      meta.name ||
      meta.full_name ||
      meta.user_name ||
      email.split('@')[0] ||
      '用户';
    const role: string = (p?.id === s.user.id && p.role) || s.profile?.role || 'user';
    return { id: s.user.id, name, email, role };
  } catch {
    return null;
  }
}

export function initUserMenu(root: ParentNode = document) {
  const box = root.querySelector<HTMLElement>('[data-user-menu]');
  if (!box) return;
  const out = box.querySelector<HTMLElement>('[data-signed-out]')!;
  const btn = box.querySelector<HTMLButtonElement>('[data-signed-in]')!;
  const menu = box.querySelector<HTMLElement>('[data-menu]')!;
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  const paint = () => {
    const v = readViewer();
    out.hidden = !!v;
    btn.hidden = !v;
    if (!v) {
      close();
      return;
    }
    btn.querySelector('[data-initials]')!.textContent = initials(v.name);
    // 可访问名称放在隐藏文字里（不用 aria-label，避免与可见的姓名首字不一致：WCAG 2.5.3）
    btn.querySelector('[data-btn-label]')!.textContent = `账户菜单：${v.name}`;
    menu.querySelector('[data-name]')!.textContent = v.name;
    menu.querySelector('[data-email]')!.textContent = v.email;
    menu
      .querySelector<HTMLAnchorElement>('[data-profile-link]')
      ?.setAttribute('href', `/u/?id=${encodeURIComponent(v.id)}`);
    const adminLink = menu.querySelector<HTMLElement>('[data-admin-link]');
    if (adminLink) adminLink.hidden = !(v.role === 'admin' || v.role === 'moderator');
    void refreshUnread();
  };
  /** 未读通知角标：只有登录用户才动态加载数据层查询（未登录访客的首屏不受影响） */
  const badge = btn.querySelector<HTMLElement>('[data-unread-badge]');
  const count = menu.querySelector<HTMLElement>('[data-unread-count]');
  let unreadSeq = 0;
  async function refreshUnread() {
    const seq = ++unreadSeq;
    const v = readViewer();
    let n = 0;
    if (v) {
      try {
        const { getRepository } = await import('@/lib/data');
        n = await getRepository().notifications.unreadCount();
      } catch {
        n = 0;
      }
    }
    if (seq !== unreadSeq) return;
    const text = n > 99 ? '99+' : String(n);
    if (badge) {
      badge.hidden = !n;
      badge.textContent = n ? text : '';
    }
    if (count) {
      count.hidden = !n;
      count.textContent = n ? `${text} 条未读` : '';
    }
    if (v)
      btn.querySelector('[data-btn-label]')!.textContent = n
        ? `账户菜单：${v.name}，${text} 条未读通知`
        : `账户菜单：${v.name}`;
  }
  addEventListener('az:notifications', () => void refreshUnread());
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  };
  function close(focus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  }

  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') close(true);
    else if (e.key === 'ArrowDown') list[(i + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(i - 1 + list.length) % list.length]?.focus();
    else if (e.key === 'Home') list[0]?.focus();
    else if (e.key === 'End') list[list.length - 1]?.focus();
    else if (e.key === 'Tab') {
      // D07 / T012：Tab / Shift+Tab 离开菜单即关闭（menu 语义的完整键盘行为），焦点按默认顺序继续走
      close(false);
      return;
    } else return;
    e.preventDefault();
  });
  // 焦点被其它方式移出（点击别处、读屏跳转）时也关闭，不留悬空菜单
  box.addEventListener('focusout', (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && !box.contains(next)) close(false);
  });
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target as Node)) close();
  });
  menu.querySelector('[data-signout]')?.addEventListener('click', async () => {
    const { getRepository } = await import('@/lib/data');
    await getRepository().auth.signOut();
    localStorage.removeItem(PROFILE_KEY);
    close();
    paint();
    dispatchEvent(new CustomEvent('az:auth'));
    if (/^\/(settings|notifications|admin)\//.test(location.pathname)) location.assign('/');
  });
  addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY || e.key === PROFILE_KEY) paint();
  });
  addEventListener('az:auth', paint);
  paint();
}
