/**
 * 条目色相（卡片渐变封面、详情页横幅、无图标时的文字图标底色）。
 * 颜色值在 src/styles/global.css 的 [data-hue] 里；渐变只用 CSS（color-mix），不生成图片。
 */
import type { AiCategory } from './app-store';

export const HUES = ['accent', 'green', 'teal', 'blue', 'orange', 'purple'] as const;
export type Hue = (typeof HUES)[number];

/** AI 工具没有写 hue 时按主分类配色 */
export const AI_CATEGORY_HUE: Record<AiCategory, Hue> = {
  agent: 'blue',
  'vibe-coding': 'teal',
  cli: 'accent',
  'ai-bot': 'orange',
  mcp: 'green',
};

export const toolHue = (d: { hue?: Hue; categories: AiCategory[] }): Hue =>
  d.hue ?? AI_CATEGORY_HUE[d.categories[0]];
