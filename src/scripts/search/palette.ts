/**
 * Ctrl/⌘K 搜索面板（T7.1）：原生 <dialog>（模态、Esc 关闭、背景 inert），输入框是 combobox，
 * 结果是 listbox 里的 a[role=option]（↑↓ 选择、Enter 打开、可以中键 / ⌘ 点击新标签页打开）。
 * 第一次打开时才创建 DOM 并下载 Pagefind 与站内索引。
 */
import { url } from '@/lib/routes';
import { searchSite, warmUp } from './engine';
import { hitRow } from './render';

let dialog: HTMLDialogElement;
let input: HTMLInputElement;
let list: HTMLElement;
let status: HTMLElement;
let more: HTMLAnchorElement;
let active = -1;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let opener: Element | null = null;

/** 面板文案（T7.6：英文页面用英文；英文页面只搜英文索引） */
const ZH = {
  title: '站内搜索',
  placeholder: '搜索应用、AI 工具、视频、文章…',
  label: '搜索关键词',
  close: '关闭搜索',
  results: '搜索结果',
  hint: '支持中文、英文与拼音首字母。',
  keys: '↑↓ 选择 · Enter 打开 · Esc 关闭',
  more: '搜索页（含社区主题）',
  count: (n: number) => `${n} 条结果，按 Enter 打开第一条`,
  none: (t: string) => `没有找到“${t}”。换个更短的关键词，或到搜索页查看社区主题。`,
  failed: '搜索索引加载失败，请检查网络后重试。',
};
const EN: typeof ZH = {
  title: 'Search this site',
  placeholder: 'Search apps, AI tools, videos, games…',
  label: 'Search terms',
  close: 'Close search',
  results: 'Search results',
  hint: 'Searches the English pages.',
  keys: '↑↓ select · Enter open · Esc close',
  more: 'Full search (Chinese)',
  count: (n: number) => `${n} result${n === 1 ? '' : 's'}, press Enter to open the first`,
  none: (t: string) => `Nothing found for “${t}”. Try a shorter word.`,
  failed: 'The search index failed to load. Check your connection and try again.',
};
let T = ZH;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export function initPalette() {
  if (dialog) return;
  T = document.documentElement.lang === 'en' ? EN : ZH;
  dialog = el('dialog', 'palette');
  dialog.setAttribute('aria-labelledby', 'palette-title');
  dialog.dataset.palette = '';
  const title = el('h2', 'visually-hidden');
  title.id = 'palette-title';
  title.textContent = T.title;
  const form = el('form', 'palette__form');
  form.setAttribute('role', 'search');
  form.action = '/search/';
  form.method = 'get';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>';
  input = el('input', 'palette__input');
  Object.assign(input, {
    type: 'search',
    name: 'q',
    placeholder: T.placeholder,
    autocomplete: 'off',
    spellcheck: false,
    enterKeyHint: 'go',
  });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', T.label);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'palette-list');
  const close = el('button', 'palette__close');
  close.type = 'button';
  close.textContent = 'Esc';
  close.setAttribute('aria-label', T.close);
  form.append(icon, input, close);
  list = el('div', 'palette__list list-group');
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', T.results);
  list.hidden = true;
  status = el('p', 'palette__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = T.hint;
  const foot = el('div', 'palette__foot');
  const keys = el('span');
  keys.setAttribute('aria-hidden', 'true');
  keys.textContent = T.keys;
  more = el('a');
  more.href = '/search/';
  more.textContent = T.more;
  foot.append(keys, more);
  dialog.append(title, form, status, list, foot);
  document.body.append(dialog);

  close.addEventListener('click', () => dialog.close());
  // 点遮罩关闭（点击落在 dialog 自身而不是内容上）
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    if (opener instanceof HTMLElement) opener.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = options()[active];
    location.assign(target ? target.href : url.search(input.value.trim()));
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    more.href = url.search(input.value.trim());
    timer = setTimeout(() => void run(input.value), 120);
  });
  input.addEventListener('keydown', (e) => {
    // type=search 的输入框里 Esc 默认只清空文字（Chromium），这里直接关闭面板
    if (e.key === 'Escape') {
      e.preventDefault();
      dialog.close();
      return;
    }
    const opts = options();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!opts.length) return;
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      select(active < 0 && d < 0 ? opts.length - 1 : (active + d + opts.length) % opts.length);
    } else if (e.key === 'Home' && e.ctrlKey) select(0);
    else if (e.key === 'End' && e.ctrlKey) select(opts.length - 1);
  });
}

const options = () => [...list.querySelectorAll<HTMLAnchorElement>('[role="option"]')];

function select(i: number) {
  const opts = options();
  opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === i)));
  active = i;
  const cur = opts[i];
  if (cur) {
    input.setAttribute('aria-activedescendant', cur.id);
    cur.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

async function run(q: string) {
  const my = ++seq;
  const term = q.trim();
  if (!term) {
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    select(-1);
    status.textContent = T.hint;
    return;
  }
  dialog.setAttribute('aria-busy', 'true');
  try {
    const { hits } = await searchSite(term, 20);
    if (my !== seq) return;
    list.replaceChildren(...hits.map((h, i) => hitRow(h, { id: `palette-opt-${i}`, option: true })));
    list.hidden = hits.length === 0;
    input.setAttribute('aria-expanded', String(hits.length > 0));
    select(hits.length ? 0 : -1);
    status.textContent = hits.length ? T.count(hits.length) : T.none(term);
  } catch {
    if (my !== seq) return;
    status.textContent = T.failed;
  } finally {
    if (my === seq) dialog.removeAttribute('aria-busy');
  }
}

export function openPalette(query = '') {
  initPalette();
  if (dialog.open) {
    input.select();
    return;
  }
  opener = document.activeElement;
  warmUp();
  dialog.showModal();
  if (query) input.value = query;
  input.focus();
  input.select();
  if (input.value.trim()) void run(input.value);
}
