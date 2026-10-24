---
{
  "title": "构建更有效的 AI 智能体",
  "originalTitle": "Building more effective AI agents",
  "summary": "《Building Effective Agents》一文的合著者与 Alex Albert 复盘半年来智能体的变化：用 Claude Agent SDK 搭建智能体、Agent Skills 的用法、多智能体的常见模式（并行、MapReduce、子智能体），以及最常见的失败方式和入门建议。",
  "provider": "youtube",
  "videoId": "uhJJgc-0iTQ",
  "channel": {
    "name": "Anthropic",
    "url": "https://www.youtube.com/@anthropic-ai"
  },
  "categories": [
    "ai-coding"
  ],
  "tags": [
    "agents",
    "multi-agent",
    "agent-sdk"
  ],
  "duration": "18:58",
  "published": "2025-10-17T16:01:56+00:00",
  "lang": "en",
  "chapters": [
    {
      "t": "0:00",
      "label": "开场介绍"
    },
    {
      "t": "0:35",
      "label": "训练 Claude 处理智能体任务"
    },
    {
      "t": "1:30",
      "label": "让 Claude 借助代码更自主"
    },
    {
      "t": "3:20",
      "label": "用 Claude Agent SDK 构建智能体"
    },
    {
      "t": "5:00",
      "label": "Agent Skills 使用技巧"
    },
    {
      "t": "6:40",
      "label": "工作流与智能体的演变"
    },
    {
      "t": "8:30",
      "label": "简单架构的价值"
    },
    {
      "t": "9:30",
      "label": "多智能体系统：编排者、子智能体与工具调用"
    },
    {
      "t": "11:40",
      "label": "训练 Claude 使用子智能体"
    },
    {
      "t": "12:25",
      "label": "多智能体设计模式：并行、MapReduce、测试时计算"
    },
    {
      "t": "13:20",
      "label": "用工具和子智能体协同解题"
    },
    {
      "t": "14:15",
      "label": "智能体常见的失败方式"
    },
    {
      "t": "15:00",
      "label": "入门最佳实践：上下文工程、MCP 与工具"
    },
    {
      "t": "17:15",
      "label": "智能体的未来：编程、电脑操作及更多"
    }
  ],
  "relatedTools": [
    "claude-code",
    "claude",
    "mcp-servers"
  ],
  "lastChecked": "2026-10-25",
  "verifiedBy": "YouTube oEmbed（标题 / 频道 / 可嵌入）+ 频道 RSS（发布时间）+ 频道或播放列表页（时长）",
  "order": 3
}
---

<p>很多人第一次做智能体，会直接上复杂的多智能体框架，结果难以调试。这期对谈延续了 Anthropic 那篇广为流传的工程博客的思路：<strong>先用最简单的结构解决问题，只有在确实需要时才增加复杂度</strong>。视频把半年来的新变化——Agent SDK、Agent Skills、子智能体——放进这个框架里讲。</p>
<p>中段关于多智能体模式的部分信息密度最高：编排者如何把任务拆给子智能体、什么时候适合并行或 MapReduce、为什么「多花算力换准确率」在某些任务上是划算的。结尾列举的失败方式（上下文塞太满、工具描述含糊等）对正在做 AI 自动化的读者很有参考价值。</p>
<h3>看点</h3>
<ul><li>工作流（预先写好的步骤）与智能体（模型自己决定步骤）的区别与组合。</li><li>多智能体常见模式及其适用场景。</li><li>上下文工程、MCP 与工具设计的入门建议。</li></ul>
