/**
 * 两轮审计里已知、由后续任务关闭的问题：对应用例以 test.fixme 登记（DESIGN-QA / PLAN T9.2）。
 * 关闭一项时删掉这里的条目，用例自动变为阻断。键：`<检查>:<页面名>@<视口名>`，`*` 匹配任意。
 */
export const KNOWN: Record<string, string> = {
  // PR B（T9.7–T9.10）已关闭：singlechar@768 / @844x390（T9.10 导航）、midword home@320（T9.11 精选卡）、
  // zoom app-detail@390（T9.8 统计格）、glyph（T9.7 Lucide 图标）。新发现的问题按同样格式登记。
};

export function knownIssue(check: string, page: string, vp: string): string | undefined {
  for (const k of [`${check}:${page}@${vp}`, `${check}:${page}@*`, `${check}:*@${vp}`, `${check}:*@*`]) {
    if (KNOWN[k]) return KNOWN[k];
  }
  return undefined;
}
