/**
 * 标签（T7.2）：内容里写 ASCII slug（应用 / AI 工具 / 视频 / 文章的 `tags`），这里登记显示名。
 * 新增标签时在这里加一行（tests/unit/tags.test.ts 会检查内容里用到的每个标签都已登记）。
 * description 可选：没有时标签页用通用说明。
 */
export interface TagInfo {
  name: string;
  description?: string;
}

export const TAGS: Record<string, TagInfo> = {
  // —— 文章（原有，带说明）
  'dev-practice': { name: '开发实践', description: '工程方法、实现细节与取舍记录。' },
  fablemotion: { name: 'FableMotion', description: 'FableMotion 动画编辑器的开发与复盘。' },
  'browser-extension': { name: '浏览器扩展', description: 'Chrome MV3 扩展的权限、扫描与发布实践。' },
  'ai-games': { name: 'AI 游戏', description: '游戏系统设计、存档迁移与 AI 辅助开发。' },
  tested: { name: '实测', description: '有可复现实测数据支撑的文章。' },
  original: { name: '原创', description: '原创技术文章。' },
  retrospective: { name: '复盘', description: '项目复盘与失败记录。' },
  // —— 通用
  'open-source': { name: '开源', description: '源代码公开、可以自己部署或修改的项目。' },
  agents: { name: '智能体' },
  agent: { name: 'AI 智能体' },
  'general-agent': { name: '通用智能体' },
  'multi-agent': { name: '多智能体' },
  'coding-agent': { name: '编程智能体', description: '能读写代码、执行命令的 AI 编程助手。' },
  'cloud-agents': { name: '云端智能体' },
  'agent-sdk': { name: 'Agent SDK' },
  mcp: { name: 'MCP', description: 'Model Context Protocol：让 AI 工具连接外部数据与工具的开放协议。' },
  terminal: { name: '终端' },
  cli: { name: '命令行' },
  'app-builder': { name: '应用生成', description: '用对话或提示词生成可运行应用的工具。' },
  chatbot: { name: '聊天机器人' },
  'no-code': { name: '无代码' },
  'ai-editor': { name: 'AI 编辑器' },
  'ai-ide': { name: 'AI IDE' },
  workflow: { name: '工作流' },
  automation: { name: '自动化' },
  'self-hosted': { name: '可自托管' },
  'local-llm': { name: '本地大模型' },
  llm: { name: '大语言模型' },
  'llm-app': { name: '大模型应用' },
  rag: { name: 'RAG 检索增强' },
  reasoning: { name: '推理模型' },
  multimodal: { name: '多模态' },
  prompting: { name: '提示词' },
  'pair-programming': { name: '结对编程' },
  'code-completion': { name: '代码补全' },
  'code-review': { name: '代码审查' },
  'pull-request': { name: 'Pull Request' },
  'spec-driven': { name: '规格驱动开发' },
  'browser-automation': { name: '浏览器自动化' },
  testing: { name: '测试' },
  'regression-testing': { name: '回归测试' },
  'online-ide': { name: '在线 IDE' },
  'bot-builder': { name: '机器人搭建' },
  'chat-ui': { name: '聊天界面' },
  assistant: { name: '助手' },
  writing: { name: '写作' },
  reference: { name: '参考资料' },
  'best-practices': { name: '最佳实践' },
  beginner: { name: '入门' },
  'open-standard': { name: '开放标准' },
  api: { name: 'API' },
  gui: { name: '图形界面' },
  desktop: { name: '桌面端' },
  web: { name: 'Web' },
  chinese: { name: '中文友好' },
  // —— 平台 / 厂商 / 技术
  github: { name: 'GitHub' },
  anthropic: { name: 'Anthropic' },
  openai: { name: 'OpenAI' },
  'openai-compatible': { name: 'OpenAI 兼容' },
  google: { name: 'Google' },
  gemini: { name: 'Gemini' },
  bytedance: { name: '字节跳动' },
  aws: { name: 'AWS' },
  ollama: { name: 'Ollama' },
  windsurf: { name: 'Windsurf' },
  'claude-code': { name: 'Claude Code' },
  codex: { name: 'Codex' },
  bugbot: { name: 'Bugbot' },
  vscode: { name: 'VS Code' },
  'vscode-extension': { name: 'VS Code 扩展' },
  'chrome-mv3': { name: 'Chrome MV3' },
  react: { name: 'React' },
  nextjs: { name: 'Next.js' },
  rust: { name: 'Rust' },
  webcontainers: { name: 'WebContainers' },
  'web-audio': { name: 'Web Audio' },
  gateway: { name: '网关' },
  local: { name: '本地运行' },
  offline: { name: '离线可用' },
  'single-file': { name: '单文件' },
  editor: { name: '编辑器' },
  'editor-tools': { name: '编辑器工具' },
  // —— 创作 / 媒体
  video: { name: '视频' },
  animation: { name: '动画' },
  timeline: { name: '时间轴' },
  recording: { name: '录屏' },
  image: { name: '图片' },
  audio: { name: '音频' },
  procedural: { name: '程序化生成' },
  design: { name: '设计' },
  blender: { name: 'Blender' },
  rendering: { name: '渲染' },
  '3d': { name: '3D' },
  gpu: { name: 'GPU' },
  shaders: { name: '着色器' },
  lighting: { name: '光照' },
  megalights: { name: 'MegaLights' },
  vfx: { name: '视觉特效' },
  'pixel-art': { name: '像素美术' },
  showreel: { name: '作品集锦' },
  trailer: { name: '预告片' },
  // —— 游戏开发
  godot: { name: 'Godot', description: '开源游戏引擎 Godot 的教程、作品与工具。' },
  unity: { name: 'Unity' },
  unreal: { name: 'Unreal' },
  gdscript: { name: 'GDScript' },
  'game-design': { name: '游戏设计' },
  'game-jam': { name: 'Game Jam' },
  'game-prototype': { name: '游戏原型' },
  'indie-games': { name: '独立游戏' },
  'indie-dev': { name: '独立开发' },
  optimization: { name: '性能优化' },
  multiplayer: { name: '多人游戏' },
  netcode: { name: '网络同步' },
  cozy: { name: '治愈系' },
  strategy: { name: '策略' },
  rpg: { name: 'RPG' },
  roguelike: { name: 'Roguelike' },
  deckbuilder: { name: '卡牌构筑' },
  survival: { name: '生存' },
  'co-op': { name: '合作' },
};

export const tagName = (slug: string) => TAGS[slug]?.name ?? slug;
export const tagDescription = (slug: string, count: number) =>
  TAGS[slug]?.description
    ? `${TAGS[slug].description}共 ${count} 个条目。`
    : `标记为「${tagName(slug)}」的应用、AI 工具、视频与文章，共 ${count} 个条目。`;

export type TaggedType = 'app' | 'tool' | 'video' | 'article';
export const TAGGED_TYPE_LABEL: Record<TaggedType, string> = {
  app: '应用',
  tool: 'AI 工具',
  video: '视频',
  article: '文章',
};
export const TAGGED_ORDER: TaggedType[] = ['app', 'tool', 'video', 'article'];

export interface TaggedItem {
  type: TaggedType;
  title: string;
  url: string;
  summary: string;
  tags: string[];
}

export interface TagEntry {
  slug: string;
  name: string;
  count: number;
  /** 1–5：标签云字号档位（按数量的对数分档；最多的为 5） */
  weight: number;
  byType: Partial<Record<TaggedType, number>>;
  items: TaggedItem[];
}

/** 至少这么多条目才单独可收录（只有 1 条的标签页 noindex、不进 sitemap，避免薄内容） */
export const TAG_INDEX_MIN = 2;

/** 汇总全部内容的标签：数量是真实条目数（同一条目重复写同一标签只算一次） */
export function aggregateTags(items: TaggedItem[]): TagEntry[] {
  const map = new Map<string, TaggedItem[]>();
  for (const it of items)
    for (const t of new Set(it.tags)) {
      const list = map.get(t) ?? [];
      list.push(it);
      map.set(t, list);
    }
  const max = Math.max(1, ...[...map.values()].map((l) => l.length));
  return [...map.entries()]
    .map(([slug, list]) => {
      const byType: TagEntry['byType'] = {};
      for (const it of list) byType[it.type] = (byType[it.type] ?? 0) + 1;
      return {
        slug,
        name: tagName(slug),
        count: list.length,
        weight: tagWeight(list.length, max),
        byType,
        items: [...list].sort(
          (a, b) =>
            TAGGED_ORDER.indexOf(a.type) - TAGGED_ORDER.indexOf(b.type) || a.title.localeCompare(b.title),
        ),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

/** 对数分档：1 条 → 1，最多的 → 5 */
export function tagWeight(count: number, max: number): number {
  if (max <= 1 || count <= 1) return 1;
  return 1 + Math.round((Math.log(count) / Math.log(max)) * 4);
}

/** 「3 个应用 · 2 个视频」 */
export const typeSummary = (byType: TagEntry['byType']) =>
  TAGGED_ORDER.filter((t) => byType[t])
    .map((t) => `${byType[t]} 个${TAGGED_TYPE_LABEL[t]}`)
    .join(' · ');
