/**
 * 中文排版字数（DESIGN-SYSTEM §10，T9.5）：汉字 / 全角符号 = 1，拉丁字母 / 数字 / 半角符号 = 0.5。
 * 卡片字段的上下限都按这个单位算（content.config.ts 的 schema、CMS 字数提示、设计测试共用）。
 */
export function zhLength(s: string): number {
  let n = 0;
  for (const c of s) n += c.charCodeAt(0) < 0x100 ? 0.5 : 1;
  return n;
}

/** 规范区间的人话描述，给 zod 报错与 CMS hint 用 */
export const zhRangeText = (min: number | undefined, max: number) =>
  min ? `${min}–${max} 字（汉字 1、字母数字 0.5）` : `≤ ${max} 字（汉字 1、字母数字 0.5）`;
