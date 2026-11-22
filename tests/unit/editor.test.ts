// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  countChars,
  createComposer,
  DRAFT_PREFIX,
  loadDraft,
  mountEditor,
  prefixLines,
  saveDraft,
  wrapSelection,
} from '@/scripts/community/editor';
import { RateLimitedError } from '@/lib/data';
import { relTime } from '@/scripts/community/ui';

const ta = (value = '') => {
  const t = document.createElement('textarea');
  t.value = value;
  document.body.append(t);
  return t;
};

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('编辑器：选区操作', () => {
  it('wrapSelection 包住选区并保持选中文字', () => {
    const t = ta('hello world');
    t.setSelectionRange(6, 11);
    wrapSelection(t, '**');
    expect(t.value).toBe('hello **world**');
    expect(t.value.slice(t.selectionStart, t.selectionEnd)).toBe('world');
  });
  it('没有选区时插入占位文字', () => {
    const t = ta('');
    wrapSelection(t, '`', '`', 'code');
    expect(t.value).toBe('`code`');
  });
  it('prefixLines 给选中的每一行加前缀（有序列表编号递增）', () => {
    const t = ta('a\nb\nc');
    t.setSelectionRange(0, 5);
    prefixLines(t, (i) => `${i + 1}. `);
    expect(t.value).toBe('1. a\n2. b\n3. c');
  });
  it('countChars 按码点计数（与 Postgres char_length 一致）并忽略首尾空白', () => {
    expect(countChars(' 😀中a ')).toBe(3);
  });
});

describe('草稿', () => {
  it('保存 / 读取 / 清除；空内容不保存；过期草稿忽略', () => {
    saveDraft('k', '内容');
    expect(loadDraft('k')).toBe('内容');
    saveDraft('k', '  ');
    expect(localStorage.getItem(DRAFT_PREFIX + 'k')).toBeNull();
    localStorage.setItem(DRAFT_PREFIX + 'old', JSON.stringify({ v: 'x', t: Date.now() - 8 * 86400e3 }));
    expect(loadDraft('old')).toBeNull();
    saveDraft('k', 'x');
    clearDraft('k');
    expect(loadDraft('k')).toBeNull();
  });
});

describe('mountEditor', () => {
  it('计数、超长标红、校验信息与数据库约束一致', () => {
    const t = ta();
    const ed = mountEditor(t, { limit: [1, 5], label: '回复' });
    expect(ed.validate()).toBe('回复不能为空');
    ed.set('123456');
    expect(ed.root.querySelector('.composer__count')!.textContent).toBe('6 / 5');
    expect(ed.root.querySelector('.composer__count')!.classList.contains('is-over')).toBe(true);
    expect(t.getAttribute('aria-invalid')).toBe('true');
    expect(ed.validate()).toBe('回复最多 5 个字符');
  });
  it('工具栏按钮有可访问名称；快捷键 Ctrl+B 加粗', () => {
    const t = ta('abc');
    const ed = mountEditor(t, { limit: [1, 100], label: '正文' });
    const names = [...ed.root.querySelectorAll('.composer__tool')].map(
      (b) => b.querySelector('.visually-hidden')!.textContent,
    );
    expect(names).toContain('有序列表');
    expect(names.some((n) => n!.startsWith('粗体'))).toBe(true);
    t.setSelectionRange(0, 3);
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    expect(t.value).toBe('**abc**');
  });
  it('预览经净化渲染 Markdown', async () => {
    vi.useFakeTimers();
    const t = ta();
    const ed = mountEditor(t, { limit: [1, 100], label: '正文' });
    ed.set('**粗** <img src=x onerror=alert(1)>');
    vi.advanceTimersByTime(300);
    const pv = ed.root.querySelector('.composer__preview')!;
    expect(pv.querySelector('strong')!.textContent).toBe('粗');
    expect(pv.querySelector('img')).toBeNull();
    vi.useRealTimers();
  });
  it('有草稿时恢复并提示，可丢弃', () => {
    saveDraft('reply:t-a', '没写完');
    const t = ta();
    const ed = mountEditor(t, { limit: [1, 100], label: '回复', draftKey: 'reply:t-a' });
    expect(ed.restored).toBe(true);
    expect(t.value).toBe('没写完');
    const note = ed.root.querySelector<HTMLElement>('.composer__draft')!;
    expect(note.hidden).toBe(false);
    note.querySelector('button')!.click();
    expect(t.value).toBe('');
    expect(loadDraft('reply:t-a')).toBeNull();
  });
  it('编辑模式（initial）不恢复草稿', () => {
    saveDraft('k', '草稿');
    const t = ta();
    mountEditor(t, { limit: [1, 100], label: '回复', draftKey: 'k', initial: '原文' });
    expect(t.value).toBe('原文');
  });
});

describe('createComposer', () => {
  it('校验失败不提交；成功后清空并清除草稿；失败显示中文错误（限流）', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RateLimitedError('x', 'comment: 最多 5 次 / 00:01:00'));
    const { form, editor } = createComposer({
      fieldLabel: '写评论',
      submitLabel: '发表',
      limit: [1, 600],
      label: '评论',
      draftKey: 'comment:article:x',
      onSubmit,
    });
    document.body.append(form);
    form.requestSubmit();
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')!.textContent).toBe('评论不能为空');
    editor.set('第一条');
    form.requestSubmit();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('第一条'));
    await vi.waitFor(() => expect(editor.textarea.value).toBe(''));
    editor.set('第二条');
    form.requestSubmit();
    await vi.waitFor(() =>
      expect(form.querySelector('[role="alert"]')!.textContent).toBe(
        '评论太频繁了：为防止刷屏，每 1 分钟最多评论 5 次。请稍后再试。',
      ),
    );
    expect(editor.textarea.value).toBe('第二条');
    expect(form.querySelector('label')!.textContent).toBe('写评论');
  });
});

describe('相对时间', () => {
  it('刚刚 / 分钟 / 小时 / 天 / 日期', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(relTime('2026-10-24T11:59:30Z', now)).toBe('刚刚');
    expect(relTime('2026-10-24T11:50:00Z', now)).toBe('10 分钟前');
    expect(relTime('2026-10-24T09:00:00Z', now)).toBe('3 小时前');
    expect(relTime('2026-10-22T12:00:00Z', now)).toBe('2 天前');
    expect(relTime('2026-09-01T12:00:00Z', now)).toBe('2026-09-01');
  });
});
