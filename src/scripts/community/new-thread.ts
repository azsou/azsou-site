/** /forum/new/：分类 + 标题 + Markdown 正文；草稿自动保存；发布后跳到新主题。 */
import { checkLength, getRepository, LIMITS } from '@/lib/data';
import { friendlyError } from '@/lib/community-errors';
import { url } from '@/lib/routes';
import { clearDraft, countChars, loadDraft, mountEditor, saveDraft } from './editor';
import { busy, viewer } from './ui';
import { loadSiteSettings } from '../site-settings';

const root = document.querySelector<HTMLElement>('[data-new-thread]')!;
const form = root.querySelector<HTMLFormElement>('[data-signed-in]')!;
const out = root.querySelector<HTMLElement>('[data-signed-out]')!;
const banned = root.querySelector<HTMLElement>('[data-banned]')!;
const title = form.querySelector<HTMLInputElement>('#nt-title')!;
const titleCount = form.querySelector<HTMLElement>('[data-title-count]')!;
const status = form.querySelector<HTMLElement>('[data-form-status]')!;
const desc = form.querySelector<HTMLElement>('[data-cat-desc]')!;
const meta = JSON.parse(document.querySelector('[data-cat-meta]')?.textContent || '{}') as Record<
  string,
  string
>;
const params = new URLSearchParams(location.search);
const DRAFT = 'thread:new';

root.querySelector<HTMLAnchorElement>('[data-login-link]')!.href = url.login(
  location.pathname + location.search,
);

const editor = mountEditor(form.querySelector<HTMLTextAreaElement>('#nt-body')!, {
  limit: LIMITS.threadBody,
  label: '正文',
  draftKey: `${DRAFT}:body`,
  onSubmitShortcut: () => form.requestSubmit(),
});

const radios = () => [...form.querySelectorAll<HTMLInputElement>('input[name="category"]')];
const current = () => radios().find((r) => r.checked)?.value ?? 'product';
const paintCat = () => {
  desc.textContent = meta[current()] ?? '';
  const back = form.querySelector<HTMLAnchorElement>('[data-cancel]')!;
  back.href = url.forumCategory(current());
};
const wanted = params.get('cat');
const savedTitle = loadDraft(`${DRAFT}:title`);
const savedCat = loadDraft(`${DRAFT}:cat`);
for (const r of radios()) {
  if (r.value === (wanted || savedCat)) r.checked = true;
  r.addEventListener('change', () => {
    paintCat();
    saveDraft(`${DRAFT}:cat`, current());
  });
}
if (savedTitle) title.value = savedTitle;
const paintTitle = () => {
  const n = countChars(title.value);
  titleCount.textContent = String(n);
  titleCount.parentElement!.classList.toggle('is-over', n > LIMITS.threadTitle[1]);
};
title.addEventListener('input', () => {
  paintTitle();
  saveDraft(`${DRAFT}:title`, title.value);
});
paintTitle();
paintCat();

const showError = (field: 'title' | 'body', msg: string) => {
  const el = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`)!;
  el.textContent = msg;
  (field === 'title' ? title : editor.textarea).setAttribute('aria-invalid', msg ? 'true' : 'false');
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.textContent = '';
  const tErr = checkLength(title.value, LIMITS.threadTitle, '标题');
  const bErr = editor.validate();
  showError('title', tErr ?? '');
  showError('body', bErr ?? '');
  if (tErr) return title.focus();
  if (bErr) return editor.focus();
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  try {
    const t = await busy(btn, () =>
      getRepository().forum.createThread({ category: current(), title: title.value, body: editor.value() }),
    );
    editor.clear();
    clearDraft(`${DRAFT}:title`);
    clearDraft(`${DRAFT}:cat`);
    location.assign(url.forumThread(t.id));
  } catch (err) {
    status.textContent = friendlyError(err);
  }
});

/** 站点设置：停用的分类不出现、按设置排序（数据库不拦截旧客户端，见 docs/PLAN.md §5） */
async function applyCategorySettings(isAdmin: boolean) {
  const s = await loadSiteSettings();
  const picker = form.querySelector<HTMLElement>('.cat-picker')!;
  const labels = new Map(radios().map((r) => [r.value, r.closest('label')!]));
  for (const c of s.forum.categories) {
    const label = labels.get(c.id);
    if (!label) continue;
    label.hidden = !c.enabled || (c.id === 'announce' && !isAdmin);
    picker.append(label);
  }
  const visible = radios().filter((r) => !r.closest('label')!.hidden);
  if (visible.length && !visible.some((r) => r.checked)) {
    visible[0].checked = true;
    paintCat();
  }
}

void viewer().then(async (me) => {
  if (!me) return;
  out.hidden = true;
  if (me.banned) {
    banned.hidden = false;
    return;
  }
  if (me.role === 'admin')
    form.querySelectorAll<HTMLElement>('[data-admin-only]').forEach((x) => (x.hidden = false));
  await applyCategorySettings(me.role === 'admin');
  form.hidden = false;
});
