/**
 * /admin/settings/：站点公告、注册开关、论坛分类（启用 / 顺序）。每个表单单独保存。
 *
 * 写保护（A16 / T092 / T095）：
 *  - 只有从数据库成功读到真实设置后才允许编辑与保存；读取失败 / 超时时显示持续的错误提示与「重试」，
 *    表单保持停用、不填默认值、不发任何写请求（以前会 fill(默认值) 且保存可用，存在默认值覆盖真实配置的风险）。
 *  - 「重新加载」的迟到响应不会静默覆盖已修改的表单：数据库值变了就提示冲突，由管理员选择。
 */
import {
  CATEGORY_LIST,
  mergeSettings,
  normalizeAnnouncement,
  normalizeForum,
  normalizeRegistration,
  SETTING_SLUGS,
  type ForumCategorySetting,
  type SettingSlug,
  type SiteSettings,
} from '@/lib/settings';
import { canSave, createSeq, reconcile, type SettingsPhase } from '@/lib/settings-guard';
import { describeAdminError } from '@/lib/admin-errors';
import { clearSiteSettingsCache } from '../site-settings';
import { toast } from '../community/ui';
import { adminRepo, dateTime, errorText, h, initAdmin } from './shell';

const form = (slug: string) => document.querySelector<HTMLFormElement>(`[data-setting="${slug}"]`)!;
const el = <T extends HTMLElement>(f: HTMLFormElement, name: string) =>
  f.elements.namedItem(name) as unknown as T;
const NAME = Object.fromEntries(CATEGORY_LIST.map((c) => [c.id, c.name]));
const TITLE: Record<SettingSlug, string> = {
  announcement: '站点公告',
  registration: '注册',
  forum: '论坛分类',
};
const loadBox = document.querySelector<HTMLElement>('[data-settings-load]')!;
let cats: ForumCategorySetting[] = [];

// ---------------------------------------------------------------- 状态 ------
let phase: SettingsPhase = 'loading';
/** 最近一次成功从数据库读到的值（冲突判断的基线） */
let baseline: SiteSettings | null = null;
let loadedAt: string | null = null;
const dirty = new Set<SettingSlug>();
const conflicts = new Map<SettingSlug, SiteSettings[SettingSlug]>();
const seq = createSeq();

function fillSlug(slug: SettingSlug, s: SiteSettings) {
  if (slug === 'announcement') {
    const a = form('announcement');
    el<HTMLInputElement>(a, 'enabled').checked = s.announcement.enabled;
    el<HTMLTextAreaElement>(a, 'text').value = s.announcement.text;
    a.querySelector<HTMLInputElement>(`input[name="level"][value="${s.announcement.level}"]`)!.checked = true;
    el<HTMLInputElement>(a, 'link').value = s.announcement.link;
    el<HTMLInputElement>(a, 'linkText').value = s.announcement.linkText;
  } else if (slug === 'registration') {
    const r = form('registration');
    el<HTMLInputElement>(r, 'open').checked = s.registration.open;
    el<HTMLTextAreaElement>(r, 'message').value = s.registration.message;
  } else {
    cats = s.forum.categories.map((c) => ({ ...c }));
    paintCats();
  }
}

/** 表单可用性：未加载成功前整张表单停用（含保存按钮） */
function setEditable(on: boolean) {
  for (const slug of SETTING_SLUGS) {
    const f = form(slug);
    f.dataset.settingState = on ? 'ready' : phase;
    for (const c of Array.from(f.elements) as HTMLInputElement[]) c.disabled = !on;
  }
  if (on) paintCats();
}

function paintLoadBox() {
  if (phase === 'loading') {
    loadBox.dataset.state = 'loading';
    loadBox.className = 'notice settings-load';
    loadBox.setAttribute('role', 'status');
    loadBox.replaceChildren(h('span', { text: '正在从数据库读取当前设置…（读取完成前不能编辑或保存）' }));
  }
}

function showLoadError(e: unknown, keepValues: boolean) {
  const info = describeAdminError(e, '设置读取失败。');
  loadBox.dataset.state = 'error';
  loadBox.dataset.errorKind = info.kind;
  loadBox.className = 'notice notice--error settings-load';
  loadBox.setAttribute('role', 'alert');
  const retry = h('button', {
    type: 'button',
    class: 'btn btn--sm',
    text: info.retryLabel,
    'data-settings-retry': true,
  });
  retry.addEventListener('click', () => void load());
  loadBox.replaceChildren(
    h('strong', { text: keepValues ? `重新加载失败：${info.title}` : `设置读取失败：${info.title}` }),
    h('span', {
      text: keepValues
        ? ` ${info.text} 表单里仍是 ${loadedAt ? dateTime(loadedAt) : '上次'} 从数据库读到的值。`
        : ` ${info.text} 为避免用默认值覆盖数据库里的真实配置，编辑与保存已停用，成功读取后才会恢复。`,
    }),
    retry,
  );
}

function showLoaded() {
  loadBox.dataset.state = 'loaded';
  delete loadBox.dataset.errorKind;
  loadBox.className = 'settings-load settings-load--ok';
  loadBox.setAttribute('role', 'status');
  const again = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--ghost',
    text: '重新加载',
    'data-settings-reload': true,
  });
  again.addEventListener('click', () => void load());
  loadBox.replaceChildren(
    h('span', { class: 'muted', text: `已从数据库读取当前设置（${loadedAt ? dateTime(loadedAt) : ''}）。` }),
    again,
  );
}

function paintConflict(slug: SettingSlug) {
  const f = form(slug);
  f.querySelector('[data-setting-conflict]')?.remove();
  const server = conflicts.get(slug);
  if (server === undefined) return;
  const useServer = h('button', { type: 'button', class: 'btn btn--sm', text: '使用数据库中的值' });
  const keepMine = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: '保留我的修改' });
  useServer.addEventListener('click', () => {
    conflicts.delete(slug);
    dirty.delete(slug);
    baseline = { ...baseline!, [slug]: server } as SiteSettings;
    fillSlug(slug, baseline);
    paintConflict(slug);
  });
  keepMine.addEventListener('click', () => {
    // 以新的数据库值为基线：之后保存会覆盖它（管理员明确选择）
    conflicts.delete(slug);
    baseline = { ...baseline!, [slug]: server } as SiteSettings;
    paintConflict(slug);
  });
  const box = h(
    'div',
    { class: 'notice notice--error', role: 'alert', 'data-setting-conflict': true },
    h('p', {
      text: `数据库里的「${TITLE[slug]}」已被修改（可能是其他管理员或另一个标签页），与你未保存的修改不同。你的输入已保留，请选择：`,
    }),
    h('div', { class: 'btn-row' }, useServer, keepMine),
  );
  f.querySelector('[data-form-status]')!.before(box);
}

async function load() {
  const id = seq.next();
  const first = phase !== 'loaded';
  if (first) {
    phase = 'loading';
    setEditable(false);
    paintLoadBox();
  } else {
    loadBox.querySelector<HTMLButtonElement>('[data-settings-reload]')?.setAttribute('aria-busy', 'true');
  }
  try {
    const incoming = mergeSettings(await adminRepo().settings());
    if (!seq.isCurrent(id)) return; // 过期响应：丢弃
    const plan = reconcile(baseline, incoming, dirty);
    for (const slug of SETTING_SLUGS) {
      if (plan[slug] === 'apply') {
        fillSlug(slug, incoming);
        conflicts.delete(slug);
      } else if (plan[slug] === 'conflict') conflicts.set(slug, incoming[slug]);
      paintConflict(slug);
    }
    // 有冲突的表单保持旧基线，直到管理员选择
    baseline = Object.fromEntries(
      SETTING_SLUGS.map((s) => [s, plan[s] === 'conflict' && baseline ? baseline[s] : incoming[s]]),
    ) as unknown as SiteSettings;
    loadedAt = new Date().toISOString();
    phase = 'loaded';
    setEditable(true);
    showLoaded();
  } catch (e) {
    if (!seq.isCurrent(id)) return;
    if (first) {
      phase = 'error';
      setEditable(false);
    }
    showLoadError(e, !first);
  }
}

// ------------------------------------------------------------ 分类列表 ------
function paintCats(focusId?: string, dir?: 'up' | 'down') {
  const list = form('forum').querySelector<HTMLElement>('[data-cat-list]')!;
  const locked = phase !== 'loaded';
  list.replaceChildren(
    ...cats.map((c, i) => {
      const up = h('button', {
        type: 'button',
        class: 'btn btn--sm icon-only',
        'aria-label': `上移「${NAME[c.id]}」`,
        text: '↑',
        disabled: locked || i === 0,
        'data-dir': 'up',
      });
      const down = h('button', {
        type: 'button',
        class: 'btn btn--sm icon-only',
        'aria-label': `下移「${NAME[c.id]}」`,
        text: '↓',
        disabled: locked || i === cats.length - 1,
        'data-dir': 'down',
      });
      const sw = h('input', {
        type: 'checkbox',
        role: 'switch',
        checked: c.enabled,
        disabled: locked,
        'aria-label': `启用「${NAME[c.id]}」`,
      });
      sw.addEventListener('change', () => {
        c.enabled = sw.checked;
        dirty.add('forum');
      });
      const move = (d: -1 | 1) => {
        const j = i + d;
        [cats[i], cats[j]] = [cats[j], cats[i]];
        dirty.add('forum');
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

// ---------------------------------------------------------------- 保存 ------
async function save(slug: SettingSlug, data: Record<string, unknown>, f: HTMLFormElement) {
  const st = f.querySelector<HTMLElement>('[data-form-status]')!;
  const gate = canSave(phase, new Set(conflicts.keys()), slug);
  if (!gate.ok) {
    // 防御：按钮已停用，但无论如何都不发写请求
    st.textContent =
      gate.reason === 'conflict'
        ? '请先处理上面的冲突（使用数据库中的值，或保留我的修改）。'
        : '设置还没有从数据库读取成功，不能保存。';
    st.className = 'form-status notice notice--error';
    return;
  }
  const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  btn.disabled = true;
  st.textContent = '正在保存…';
  st.className = 'form-status';
  try {
    const saved = await adminRepo().saveSetting(slug, data);
    const next = mergeSettings([{ slug, data: saved.data, published: saved.published }]);
    baseline = { ...baseline!, [slug]: next[slug] } as SiteSettings;
    dirty.delete(slug);
    clearSiteSettingsCache();
    st.textContent = '已保存。';
    toast('设置已保存。');
  } catch (e) {
    st.textContent = errorText(e, '保存失败');
    st.className = 'form-status notice notice--error';
  } finally {
    btn.disabled = phase !== 'loaded';
  }
}

for (const slug of SETTING_SLUGS) {
  const f = form(slug);
  const mark = (e: Event) => {
    if ((e.target as HTMLElement).closest('[data-cat-list]')) return; // 分类在 paintCats 里单独记
    if (phase === 'loaded') dirty.add(slug);
  };
  f.addEventListener('input', mark);
  f.addEventListener('change', mark);
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
  setEditable(false);
  const me = await initAdmin();
  if (!me) return;
  await load();
}
void init();
