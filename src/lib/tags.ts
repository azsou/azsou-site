/** 标签：中文名 ↔ ASCII slug。新增标签在这里登记一次。 */
export const TAGS: Record<string, { name: string; description: string }> = {
  'dev-practice': { name: '开发实践', description: '工程方法、实现细节与取舍记录。' },
  fablemotion: { name: 'FableMotion', description: 'FableMotion 动画编辑器的开发与复盘。' },
  'browser-extension': { name: '浏览器扩展', description: 'Chrome MV3 扩展的权限、扫描与发布实践。' },
  'ai-games': { name: 'AI 游戏', description: '游戏系统设计、存档迁移与 AI 辅助开发。' },
  tested: { name: '实测', description: '有可复现实测数据支撑的文章。' },
  original: { name: '原创', description: '原创技术文章。' },
  retrospective: { name: '复盘', description: '项目复盘与失败记录。' },
};

export const tagName = (slug: string) => TAGS[slug]?.name ?? slug;
