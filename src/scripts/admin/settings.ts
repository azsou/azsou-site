/** /admin/settings/：站点公告、注册开关、论坛分类（启用 / 顺序）。每个表单单独保存。 */
import {
  CATEGORY_LIST,
  mergeSettings,
  normalizeAnnouncement,
  normalizeForum,
  normalizeRegistration,
  type ForumCategorySetting,
  type SiteSettings,
} from '@/lib/settings';
import { clearSiteSettingsCache } from '../site-settings';
import { toast } from '../community/ui';
import { adminRepo, errorText, h, initAdmin } from './shell';

const form = (slug: string) => document.querySelector<HTMLFormElement>(`[data-setting="${slug}"]`)!;
const el = <T extends HTMLElement>(f: HTMLFormElement, name: string) =>
  f.elements.namedItem(name) as unknown as T;
const NAME = Object.fromEntries(CATEGORY_LIST.map((c) => [c.id, c.name]));
let cats: ForumCategorySetting[] = [];

function fill(s: SiteSettings) {
  const a = form('announcement');
  el<HTMLInputElement>(a, 'enabled').checked = s.announcement.enabled;
  el<HTMLTextAreaElement>(a, 'text').value = s.announcement.text;
  a.querySelector<HTMLInputElement>(`input[name="level"][value="${s.announcement.level}"]`)!.checked = true;
  el<HTMLInputElement>(a, 'link').value = s.announcement.link;
  el<HTMLInputElement>(a, 'linkText').value = s.announcement.linkText;
  const r = form('registration');
  el<HTMLInputElement>(r, 'open').checked = s.registration.open;
  el<HTMLTextAreaElement>(r, 'message').value = s.registration.message;
  cats = s.forum.categories.map((c) => ({ ...c }));
  paintCats();
}

function paintCats(focusId?: string, dir?: 'up' | 'down') {
  const list = form('forum').querySelector<HTMLElement>('[data-cat-list]')!;
  list.replaceChildren(
    ...cats.map((c, i) => {
      const up = h('button', {
        type: 'button',
        class: 'btn btn--sm icon-only',
        'aria-label': `上移「${NAME[c.id]}」`,
        text: '↑',
        disabled: i === 0,
        'data-dir': 'up',
      });
      const down = h('button', {
        type: 'button',
        class: 'btn btn--sm icon-only',
        'aria-label': `下移「${NAME[c.id]}」`,
        text: '↓',
        disabled: i === cats.length - 1,
        'data-dir': 'down',
      });
      const sw = h('input', {
        type: 'checkbox',
        role: 'switch',
        checked: c.enabled,
        'aria-label': `启用「${NAME[c.id]}」`,
      });
      sw.addEventListener('change', () => (c.enabled = sw.checked));
      const move = (d: -1 | 1) => {
        const j = i + d;
        [cats[i], cats[j]] = [cats[j], cats[i]];
        paintCats(c.id, d < 0 ? 'up' : 'down');
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      return h(
        'li',
        { 'data-cat': c.id },
        h('span', { class: 'order-name', text: NAME[c.id] ?? c.id }),
        h('label', { class: 'switch' }, h('span', { text: '启用' }), sw),
        up,
        down,
      );
    }),
  );
  // 移动后保持焦点在同一个分类的同方向按钮上（键盘可连续操作）
  if (focusId) {
    const li = list.querySelector<HTMLElement>(`[data-cat="${focusId}"]`);
    const btn =
      li?.querySelector<HTMLButtonElement>(`[data-dir="${dir}"]:not([disabled])`) ??
      li?.querySelector<HTMLButtonElement>('button:not([disabled])');
    btn?.focus();
  }
}

async function save(slug: string, data: Record<string, unknown>, f: HTMLFormElement) {
  const st = f.querySelector<HTMLElement>('[data-form-status]')!;
  const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  btn.disabled = true;
  st.textContent = '正在保存…';
  st.className = 'form-status';
  try {
    await adminRepo().saveSetting(slug, data);
    clearSiteSettingsCache();
    st.textContent = '已保存。';
    toast('设置已保存。');
  } catch (e) {
    st.textContent = errorText(e, '保存失败');
    st.className = 'form-status notice notice--error';
  } finally {
    btn.disabled = false;
  }
}

form('announcement').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form('announcement');
  const raw = {
    enabled: el<HTMLInputElement>(f, 'enabled').checked,
    text: el<HTMLTextAreaElement>(f, 'text').value,
    level: f.querySelector<HTMLInputElement>('input[name="level"]:checked')?.value,
    link: el<HTMLInputElement>(f, 'link').value,
    linkText: el<HTMLInputElement>(f, 'linkText').value,
  };
  const st = f.querySelector<HTMLElement>('[data-form-status]')!;
  if (raw.enabled && !raw.text.trim()) {
    st.textContent = '启用公告时请填写内容。';
    st.className = 'form-status notice notice--error';
    return;
  }
  if (raw.link.trim() && !normalizeAnnouncement({ ...raw, text: 'x' }).link) {
    st.textContent = '链接只能是站内路径（/ 开头）或 http(s) 地址。';
    st.className = 'form-status notice notice--error';
    return;
  }
  void save('announcement', { ...normalizeAnnouncement(raw) }, f);
});
form('registration').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form('registration');
  void save(
    'registration',
    {
      ...normalizeRegistration({
        open: el<HTMLInputElement>(f, 'open').checked,
        message: el<HTMLTextAreaElement>(f, 'message').value,
      }),
    },
    f,
  );
});
form('forum').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form('forum');
  if (!cats.some((c) => c.enabled && c.id !== 'announce')) {
    const st = f.querySelector<HTMLElement>('[data-form-status]')!;
    st.textContent = '至少保留一个普通用户可以发帖的分类。';
    st.className = 'form-status notice notice--error';
    return;
  }
  void save('forum', { ...normalizeForum({ categories: cats.map((c, i) => ({ ...c, order: i })) }) }, f);
});

async function init() {
  const me = await initAdmin();
  if (!me) return;
  try {
    fill(mergeSettings(await adminRepo().settings()));
  } catch (e) {
    toast(errorText(e, '设置加载失败，显示的是默认值。'), 'error');
    fill(mergeSettings([]));
  }
}
void init();
