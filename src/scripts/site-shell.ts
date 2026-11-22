/**
 * 全站外壳的小脚本（每页都加载，保持很小）：
 *  1. 主题（T7.5）：跟随系统 / 浅色 / 深色，存 localStorage「az-theme」；首帧前由 Base.astro 的内联脚本应用，
 *     这里只负责按钮切换、跨标签页同步与 theme-color。
 *  2. Ctrl/⌘K（T7.1）：打开站内搜索面板。面板与 Pagefind 只在第一次打开时才下载。
 */
import { applyTheme, nextTheme, readTheme, THEME_LABEL, THEME_LABEL_EN, type ThemePref } from './theme';

const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
const en = document.documentElement.lang === 'en';
const label = (t: ThemePref) =>
  en
    ? `Appearance: ${THEME_LABEL_EN[t]} (click for ${THEME_LABEL_EN[nextTheme(t)]})`
    : `外观：${THEME_LABEL[t]}（点击切换为${THEME_LABEL[nextTheme(t)]}）`;

let live: HTMLElement | null = null;
function announce(text: string) {
  if (!live) {
    live = document.createElement('p');
    live.className = 'visually-hidden';
    live.setAttribute('role', 'status');
    document.body.append(live);
  }
  live.textContent = text;
}

if (toggle) {
  toggle.setAttribute('aria-label', label(readTheme()));
  toggle.addEventListener('click', () => {
    const t = nextTheme(readTheme());
    applyTheme(t, true);
    toggle.setAttribute('aria-label', label(t));
    announce(en ? `Switched to ${THEME_LABEL_EN[t]}` : `已切换为${THEME_LABEL[t]}`);
  });
  addEventListener('storage', (e) => {
    if (e.key !== 'az-theme') return;
    const t = readTheme();
    applyTheme(t, false);
    toggle.setAttribute('aria-label', label(t));
  });
}

// ------------------------------------------------------------ 搜索面板 ------
// 快捷键提示按平台显示（D07）：Apple 设备显示 ⌘，其余 Ctrl
const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
if (/Mac|iPhone|iPad|iPod/i.test(`${nav.userAgentData?.platform ?? ''} ${navigator.platform ?? ''}`))
  for (const k of document.querySelectorAll('[data-kbd-mod]')) k.textContent = '⌘';
const openPalette = () => import('./search/palette').then((m) => m.openPalette());

addEventListener('keydown', (e) => {
  // 输入法组字中不拦截（D07：不吞中文输入）
  if (e.isComposing || e.key === 'Process') return;
  if (e.key?.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  e.preventDefault();
  void openPalette();
});
for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-palette-open]'))
  a.addEventListener('click', (e) => {
    // 新标签页 / 新窗口打开时按普通链接处理（/search/ 页面）
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    void openPalette();
  });
