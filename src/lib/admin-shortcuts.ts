/**
 * 后台键盘快捷键（P10h T10.23）：帮助面板与 src/scripts/admin/workbench.ts 共用这张表。
 * 只在焦点不在输入框 / 下拉 / 文本域、且没有打开对话框时生效；不占用浏览器与读屏常用组合键（单键、无修饰键，⌘K 除外）。
 */
export const SHORTCUTS = [
  { keys: ['Ctrl / ⌘', 'K'], label: '打开命令面板（跳转页面、搜索用户与内容）' },
  { keys: ['/'], label: '聚焦本页搜索框（没有时打开命令面板）' },
  { keys: ['j'], label: '表格：下一行' },
  { keys: ['k'], label: '表格：上一行' },
  { keys: ['x'], label: '表格：选中 / 取消选中当前行' },
  { keys: ['e'], label: '表格：打开当前行（预览抽屉或编辑）' },
  { keys: ['?'], label: '显示这张快捷键表' },
  { keys: ['Esc'], label: '关闭面板 / 抽屉 / 对话框' },
] as const;

/** 事件来自可输入元素时不处理单键快捷键 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return false;
}

/** 单键快捷键 → 动作名；有修饰键（Shift 只允许用于 ?）时返回 null */
export function shortcutAction(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** 输入法组字中（中文 / 日文等）：一律不当快捷键（D07） */
  isComposing?: boolean;
}): 'palette' | 'search' | 'next' | 'prev' | 'select' | 'open' | 'help' | null {
  if (e.isComposing || e.key === 'Process' || !e.key) return null;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') return 'palette';
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case '/':
      return 'search';
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'x':
      return 'select';
    case 'e':
      return 'open';
    case '?':
      return 'help';
    default:
      return null;
  }
}
