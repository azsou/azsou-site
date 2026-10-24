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
    return { id: s.user.id, name, email };
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
    btn.setAttribute('aria-label', `账户菜单：${v.name}`);
    menu.querySelector('[data-name]')!.textContent = v.name;
    menu.querySelector('[data-email]')!.textContent = v.email;
  };
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
    else return;
    e.preventDefault();
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
