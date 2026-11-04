// @vitest-environment jsdom
/**
 * P10h PR H：后台工作台纯逻辑——快捷键映射（T10.23）、数据表 2.0 的列 / 导出（T10.17）、抽屉时间线（T10.18）。
 */
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, isTypingTarget, shortcutAction } from '@/lib/admin-shortcuts';
import { ADMIN_GROUPS, ADMIN_SECTIONS } from '@/lib/admin-nav';
import { columnsOf, tableRows } from '@/scripts/admin/table2';
import { timelineEvents } from '@/scripts/admin/drawer';

const k = (key: string, mod: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mod,
});

describe('快捷键（T10.23）', () => {
  it('单键与 ⌘K / Ctrl+K 映射', () => {
    expect(shortcutAction(k('k', { metaKey: true }))).toBe('palette');
    expect(shortcutAction(k('K', { ctrlKey: true }))).toBe('palette');
    expect(shortcutAction(k('j'))).toBe('next');
    expect(shortcutAction(k('k'))).toBe('prev');
    expect(shortcutAction(k('x'))).toBe('select');
    expect(shortcutAction(k('e'))).toBe('open');
    expect(shortcutAction(k('/'))).toBe('search');
    expect(shortcutAction(k('?'))).toBe('help');
    // 带修饰键的不抢（Ctrl+J 是浏览器下载、Alt+E 是菜单）
    expect(shortcutAction(k('j', { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(k('e', { altKey: true }))).toBeNull();
    expect(shortcutAction(k('a'))).toBeNull();
  });
  it('D07 / T012：输入法组字中（isComposing / Process）不当快捷键，中文输入不被吞', () => {
    expect(shortcutAction({ ...k('k'), isComposing: true })).toBeNull();
    expect(shortcutAction({ ...k('k', { metaKey: true }), isComposing: true })).toBeNull();
    expect(shortcutAction(k('Process'))).toBeNull();
    expect(shortcutAction({ ...k('j'), isComposing: false })).toBe('next');
  });
  it('输入框里不触发单键快捷键', () => {
    document.body.innerHTML =
      '<input id="a"><textarea id="b"></textarea><div id="c" contenteditable="true"></div><button id="d"></button>';
    for (const id of ['a', 'b', 'c']) expect(isTypingTarget(document.getElementById(id))).toBe(true);
    expect(isTypingTarget(document.getElementById('d'))).toBe(false);
  });
  it('帮助面板列出全部快捷键', () => {
    expect(SHORTCUTS.map((s) => s.keys.at(-1))).toEqual(['K', '/', 'j', 'k', 'x', 'e', '?', 'Esc']);
  });
});

describe('分组侧栏（T10.16）', () => {
  it('每个页面都有分组与图标；分组都有页面', () => {
    for (const s of ADMIN_SECTIONS) {
      expect(
        ADMIN_GROUPS.some((g) => g.id === s.group),
        s.id,
      ).toBe(true);
      expect(s.icon, s.id).toBeTruthy();
    }
    for (const g of ADMIN_GROUPS)
      expect(
        ADMIN_SECTIONS.some((s) => s.group === g.id),
        g.id,
      ).toBe(true);
  });
});

describe('数据表 2.0（T10.17）', () => {
  const html = `<table class="data-table" data-table2="t"><thead><tr>
    <th class="col-check"><span>选择</span></th><th>内容</th><th>作者</th><th>状态</th><th class="col-actions"><span>操作</span></th>
  </tr></thead><tbody>
    <tr data-row><td class="col-check"><input type="checkbox"></td><td class="cell-main">标题 A  摘要</td><td>Mika</td><td>已发布</td><td><button>隐藏</button></td></tr>
    <tr class="no-check table-state"><td colspan="5">空</td></tr>
    <tr data-row><td class="col-check"><input type="checkbox"></td><td class="cell-main">=SUM(1)</td><td>像素旅人</td><td>已隐藏</td><td></td></tr>
  </tbody></table>`;
  it('复选、主列、操作列不能隐藏', () => {
    document.body.innerHTML = html;
    const t = document.querySelector('table')!;
    expect(columnsOf(t).map((c) => [c.label, c.locked])).toEqual([
      ['选择', true],
      ['内容', true],
      ['作者', false],
      ['状态', false],
      ['操作', true],
    ]);
  });
  it('导出当前页可见列：跳过复选 / 操作列、隐藏列与状态行', () => {
    document.body.innerHTML = html;
    const t = document.querySelector('table')!;
    expect(tableRows(t, [])).toEqual({
      cols: ['内容', '作者', '状态'],
      rows: [
        ['标题 A 摘要', 'Mika', '已发布'],
        ['=SUM(1)', '像素旅人', '已隐藏'],
      ],
    });
    expect(tableRows(t, [3]).cols).toEqual(['内容', '状态']);
  });
});

describe('详情抽屉时间线（T10.18）', () => {
  it('注册 + 封禁 / 解封 + 审计，按时间倒序，封禁类审计不重复', () => {
    const u = {
      id: 'u',
      displayName: 'A',
      role: 'user' as const,
      banned: false,
      createdAt: '2026-01-01T00:00:00Z',
      email: null,
      threads: 0,
      replies: 0,
      comments: 0,
      reportsAgainst: 0,
      banReason: null,
      banExpiresAt: null,
    };
    const ev = timelineEvents(
      u,
      [
        {
          id: 1,
          reason: '刷屏',
          expiresAt: '2026-03-01T00:00:00Z',
          createdBy: null,
          createdAt: '2026-02-01T00:00:00Z',
          liftedAt: '2026-02-10T00:00:00Z',
          liftedBy: null,
          liftReason: '申诉通过',
        },
      ],
      [
        {
          id: 1,
          actor: null,
          actorRole: null,
          action: 'user.ban',
          targetType: 'user',
          targetId: 'u',
          detail: {},
          createdAt: '2026-02-01T00:00:00Z',
        },
        {
          id: 2,
          actor: null,
          actorRole: null,
          action: 'user.warn',
          targetType: 'user',
          targetId: 'u',
          detail: {},
          createdAt: '2026-04-01T00:00:00Z',
        },
      ],
    );
    expect(ev.map((e) => e.title)).toEqual(['警告用户', '解除封禁', '被封禁（有期限）', '注册账号']);
  });
});

describe('A11 抽屉未保存提示', () => {
  it('多行文本有未保存输入时判为未保存；清空 / 未改动 / 只读不算', async () => {
    const { hasUnsaved } = await import('@/scripts/admin/drawer');
    document.body.innerHTML =
      '<div id="r"><textarea id="t"></textarea><input type="datetime-local" id="d"></div>';
    const r = document.getElementById('r')!;
    (document.getElementById('d') as HTMLInputElement).value = '2026-10-28T10:00';
    expect(hasUnsaved(r)).toBe(false);
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = '备注草稿';
    expect(hasUnsaved(r)).toBe(true);
    t.readOnly = true;
    expect(hasUnsaved(r)).toBe(false);
    t.readOnly = false;
    t.value = '  ';
    expect(hasUnsaved(r)).toBe(false);
  });
});
