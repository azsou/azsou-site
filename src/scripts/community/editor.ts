/**
 * Markdown 编辑器：textarea + 格式工具栏 + 实时预览 + 字数（与数据库 char_length 约束一致）+ 草稿自动保存。
 *  - 宽屏（容器 ≥ 640px）编辑区与预览并排、边写边看；窄屏用「编辑 / 预览」切换。
 *  - 快捷键：⌘/Ctrl+B 粗体、⌘/Ctrl+I 斜体、⌘/Ctrl+K 链接、⌘/Ctrl+Enter 提交。
 *  - 草稿存 localStorage（az-draft:<key>），7 天过期；提交成功后清除。
 */
import { checkLength } from '@/lib/data/types';
import { markdownHtml } from '@/lib/sanitize';
import { friendlyError } from '@/lib/community-errors';
import { busy, h } from './ui';

export const DRAFT_PREFIX = 'az-draft:';
const DRAFT_TTL = 7 * 86400 * 1000;

export function loadDraft(key: string): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) ?? 'null');
    if (!raw || typeof raw.v !== 'string' || Date.now() - Number(raw.t) > DRAFT_TTL) return null;
    return raw.v;
  } catch {
    return null;
  }
}
export function saveDraft(key: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ v: value, t: Date.now() }));
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* 隐私模式 / 配额满：静默 */
  }
}
export const clearDraft = (key: string) => saveDraft(key, '');

export const countChars = (s: string) => [...s.trim()].length;

/** 在选区两侧加标记；没有选区时插入占位文字并选中它 */
export function wrapSelection(ta: HTMLTextAreaElement, before: string, after = before, placeholder = '文字') {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const sel = value.slice(a, b) || placeholder;
  ta.setRangeText(before + sel + after, a, b, 'end');
  ta.setSelectionRange(a + before.length, a + before.length + sel.length);
}
/** 给选中的每一行加前缀（引用 / 列表） */
export function prefixLines(ta: HTMLTextAreaElement, prefix: (i: number) => string) {
  const { value } = ta;
  const a = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let b = value.indexOf('\n', ta.selectionEnd);
  if (b < 0) b = value.length;
  const lines = value.slice(a, b).split('\n');
  const text = lines.map((l, i) => prefix(i) + l).join('\n');
  ta.setRangeText(text, a, b, 'select');
}

const TOOLS: {
  id: string;
  label: string;
  key?: string;
  glyph: string;
  run: (ta: HTMLTextAreaElement) => void;
}[] = [
  { id: 'bold', label: '粗体', key: 'b', glyph: 'B', run: (ta) => wrapSelection(ta, '**') },
  { id: 'italic', label: '斜体', key: 'i', glyph: 'I', run: (ta) => wrapSelection(ta, '*') },
  { id: 'strike', label: '删除线', glyph: 'S', run: (ta) => wrapSelection(ta, '~~') },
  { id: 'code', label: '行内代码', glyph: '</>', run: (ta) => wrapSelection(ta, '`', '`', 'code') },
  {
    id: 'link',
    label: '链接',
    key: 'k',
    glyph: '🔗',
    run: (ta) => {
      const { selectionStart: a, selectionEnd: b, value } = ta;
      const text = value.slice(a, b) || '链接文字';
      const insert = `[${text}](https://)`;
      ta.setRangeText(insert, a, b, 'end');
      const urlStart = a + text.length + 3;
      ta.setSelectionRange(urlStart, urlStart + 8);
    },
  },
  { id: 'quote', label: '引用', glyph: '❝', run: (ta) => prefixLines(ta, () => '> ') },
  { id: 'ul', label: '无序列表', glyph: '•', run: (ta) => prefixLines(ta, () => '- ') },
  { id: 'ol', label: '有序列表', glyph: '1.', run: (ta) => prefixLines(ta, (i) => `${i + 1}. `) },
  {
    id: 'codeblock',
    label: '代码块',
    glyph: '{ }',
    run: (ta) => wrapSelection(ta, '\n```\n', '\n```\n', 'code'),
  },
];

export interface EditorOptions {
  /** [最少, 最多]，与数据库约束一致（LIMITS） */
  limit: readonly [number, number];
  /** 错误提示里的名称：标题 / 正文 / 回复 / 评论 */
  label: string;
  draftKey?: string;
  /** 已有内容（编辑模式）；有 initial 时不恢复草稿 */
  initial?: string;
  /** ⌘/Ctrl+Enter */
  onSubmitShortcut?: () => void;
}

export interface Editor {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  value(): string;
  set(v: string): void;
  /** 校验失败返回中文错误，否则 null */
  validate(): string | null;
  clear(): void;
  focus(): void;
  restored: boolean;
}

let seq = 0;

/** 把一个 textarea 增强为 Markdown 编辑器（textarea 原地保留，不造成布局跳动） */
export function mountEditor(ta: HTMLTextAreaElement, opts: EditorOptions): Editor {
  seq += 1;
  const id = ta.id || `md-${seq}`;
  ta.id = id;
  ta.classList.add('composer__input');
  // 草稿由我们自己保存；关掉浏览器的表单恢复，避免与草稿重复或冲突
  ta.setAttribute('autocomplete', 'off');
  const [, max] = opts.limit;

  const root = h('div', { class: 'composer', 'data-mode': 'write' });
  const bar = h('div', {
    class: 'composer__bar',
    role: 'toolbar',
    'aria-label': '格式',
    'aria-controls': id,
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  for (const t of TOOLS) {
    const name = t.key ? `${t.label}（${mac ? '⌘' : 'Ctrl+'}${t.key.toUpperCase()}）` : t.label;
    const b = h('button', { type: 'button', class: 'composer__tool', 'data-tool': t.id, title: name });
    // 名称用隐藏文字而不是 aria-label：可见的是符号（B、1.），WCAG 2.5.3 要求标签包含可见文字
    b.append(
      h('span', { 'aria-hidden': 'true', text: t.glyph }),
      h('span', { class: 'visually-hidden', text: name }),
    );
    b.addEventListener('click', () => {
      ta.focus();
      t.run(ta);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    bar.append(b);
  }
  const writeBtn = h('button', {
    type: 'button',
    class: 'composer__mode',
    'aria-pressed': 'true',
    text: '编辑',
  });
  const previewBtn = h('button', {
    type: 'button',
    class: 'composer__mode',
    'aria-pressed': 'false',
    text: '预览',
  });
  const modes = h(
    'div',
    { class: 'segmented composer__modes', role: 'group', 'aria-label': '视图' },
    writeBtn,
    previewBtn,
  );
  const head = h('div', { class: 'composer__head' }, bar, modes);

  const preview = h('div', {
    class: 'composer__preview ugc',
    id: `${id}-preview`,
    'aria-label': '预览',
    role: 'region',
    'aria-live': 'polite',
  });
  const counter = h('span', { class: 'composer__count', id: `${id}-count`, 'aria-live': 'polite' });
  const hint = h('span', {
    class: 'composer__hint',
    id: `${id}-hint`,
    text: '支持 Markdown：**粗体**、*斜体*、`代码`、> 引用、- 列表、[链接](https://…)',
  });
  const draftNote = h('p', { class: 'composer__draft', hidden: true });
  const foot = h('div', { class: 'composer__foot' }, hint, counter);

  ta.parentNode?.insertBefore(root, ta);
  const panes = h('div', { class: 'composer__panes' }, ta, preview);
  root.append(head, draftNote, panes, foot);
  const describedBy = new Set((ta.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
  describedBy.add(hint.id);
  describedBy.add(counter.id);
  ta.setAttribute('aria-describedby', [...describedBy].join(' '));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const renderPreview = () => {
    const v = ta.value;
    preview.innerHTML = v.trim() ? markdownHtml(v) : '<p class="muted">预览会显示在这里。</p>';
  };
  const paintCount = () => {
    const n = countChars(ta.value);
    counter.textContent = `${n} / ${max}`;
    const over = n > max;
    counter.classList.toggle('is-over', over);
    if (over) ta.setAttribute('aria-invalid', 'true');
    else ta.removeAttribute('aria-invalid');
  };
  const setMode = (m: 'write' | 'preview') => {
    root.dataset.mode = m;
    writeBtn.setAttribute('aria-pressed', String(m === 'write'));
    previewBtn.setAttribute('aria-pressed', String(m === 'preview'));
    if (m === 'preview') renderPreview();
  };
  writeBtn.addEventListener('click', () => {
    setMode('write');
    ta.focus();
  });
  previewBtn.addEventListener('click', () => setMode('preview'));

  ta.addEventListener('input', () => {
    paintCount();
    clearTimeout(timer);
    timer = setTimeout(() => {
      renderPreview();
      if (opts.draftKey) saveDraft(opts.draftKey, ta.value);
    }, 200);
  });
  ta.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      opts.onSubmitShortcut?.();
      return;
    }
    const t = TOOLS.find((x) => x.key && x.key === e.key.toLowerCase());
    if (t) {
      e.preventDefault();
      t.run(ta);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  let restored = false;
  if (opts.initial != null) ta.value = opts.initial;
  else if (opts.draftKey) {
    const d = loadDraft(opts.draftKey);
    // Firefox 刷新时会自己恢复表单值（与草稿相同），这种情况也提示「已恢复草稿」
    if (d && (!ta.value || ta.value === d)) {
      ta.value = d;
      restored = true;
      const discard = h('button', { type: 'button', class: 'link-btn', text: '丢弃草稿' });
      draftNote.replaceChildren('已恢复上次未发送的草稿。', discard);
      draftNote.hidden = false;
      discard.addEventListener('click', () => {
        ta.value = '';
        clearDraft(opts.draftKey!);
        draftNote.hidden = true;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      });
    }
  }
  paintCount();
  renderPreview();

  return {
    root,
    textarea: ta,
    restored,
    value: () => ta.value.trim(),
    set(v) {
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    },
    validate: () => checkLength(ta.value, opts.limit, opts.label),
    clear() {
      ta.value = '';
      if (opts.draftKey) clearDraft(opts.draftKey);
      draftNote.hidden = true;
      paintCount();
      renderPreview();
      setMode('write');
    },
    focus: () => ta.focus(),
  };
}

export interface ComposerOptions extends EditorOptions {
  /** 可见的字段名 */
  fieldLabel: string;
  /** 视觉上隐藏字段名（上下文已说明时） */
  hideLabel?: boolean;
  submitLabel: string;
  placeholder?: string;
  rows?: number;
  onSubmit(body: string): Promise<void>;
  onCancel?(): void;
}

/** 完整的回复 / 评论 / 编辑表单 */
export function createComposer(opts: ComposerOptions): { form: HTMLFormElement; editor: Editor } {
  seq += 1;
  const id = `composer-${seq}`;
  const ta = h('textarea', {
    id,
    name: 'body',
    rows: String(opts.rows ?? 5),
    placeholder: opts.placeholder,
    required: true,
  });
  const label = h('label', {
    for: id,
    class: opts.hideLabel ? 'visually-hidden' : 'field__label',
    text: opts.fieldLabel,
  });
  const status = h('p', { class: 'notice notice--error form-status', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', text: opts.submitLabel });
  const actions = h('div', { class: 'btn-row composer__actions' }, submit);
  if (opts.onCancel) {
    const cancel = h('button', { type: 'button', class: 'btn', text: '取消' });
    cancel.addEventListener('click', () => opts.onCancel!());
    actions.prepend(cancel);
  }
  const form = h('form', { class: 'form composer-form', novalidate: true }, label, ta, status, actions);
  const editor = mountEditor(ta, { ...opts, onSubmitShortcut: () => form.requestSubmit() });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = editor.validate();
    if (err) {
      status.textContent = err;
      editor.focus();
      return;
    }
    status.textContent = '';
    try {
      await busy(submit, () => opts.onSubmit(editor.value()));
      editor.clear();
    } catch (er) {
      status.textContent = friendlyError(er);
    }
  });
  return { form, editor };
}
