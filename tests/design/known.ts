/**
 * 两轮审计里已知、由后续任务关闭的问题：对应用例以 test.fixme 登记（DESIGN-QA / PLAN T9.2）。
 * 关闭一项时删掉这里的条目，用例自动变为阻断。键：`<检查>:<页面名>@<视口名>`，`*` 匹配任意。
 */
export const KNOWN: Record<string, string> = {
  // 导航在 768 / 横屏 844×390 每项挤成两行（N-RWD-1 / N-TB-1：900–1199 五项 + 更多、< 900 TabBar）
  'singlechar:*@768': 'T9.10 导航与响应式骨架（N-RWD-1）',
  'singlechar:*@844x390': 'T9.10 导航与响应式骨架（N-TB-1）',
  // 320 宽精选卡标题「FableMotion」放不下被断开（P1-3 精选卡改版）
  'midword:home@320': 'T9.11 首页改版（精选卡标题字阶）',
  // 卡片标题 / tagline / meta 单行省略号、简介 2 行截断（P0-4）
  'trunc:*@*': 'T9.5 内容 schema 字数规格（P0-4）',
  // 仅文字放大 200% 时应用详情横向溢出 1px（N-ZOOM-1）
  'zoom:app-detail@390': 'T9.8 卡片家族与栅格（N-ZOOM-1）',
  // 站点图标：/favicon.ico 缺失、manifest 无 shortcuts（N-ICON-2）
  'favicon:*@*': 'T9.3 站点图标（N-ICON-2）',
  // 断图露出 alt 文本 / 裂图（N-IMG-2）
  'broken-img:*@*': 'T9.3 图标管线（N-IMG-2 断图兜底）',
  // 首屏图片 loading=lazy（N-IMG-3）
  'lazy:*@*': 'T9.4 封面与首屏图片（N-IMG-3）',
  // 按钮 / 链接末尾的「→ › ×」字符图标（N-ICON-1）
  'glyph:*@*': 'T9.7 Lucide 图标（N-ICON-1）',
};

export function knownIssue(check: string, page: string, vp: string): string | undefined {
  for (const k of [`${check}:${page}@${vp}`, `${check}:${page}@*`, `${check}:*@${vp}`, `${check}:*@*`]) {
    if (KNOWN[k]) return KNOWN[k];
  }
  return undefined;
}
