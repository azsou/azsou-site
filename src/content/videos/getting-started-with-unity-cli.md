---
{
  "title": "Unity CLI 入门：让 AI 智能体直接驱动编辑器",
  "originalTitle": "Getting started with Unity CLI",
  "summary": "Unity 官方教程：编辑器的图形界面对 AI 自动化来说又慢又费 token。新的 Unity CLI 负责安装编辑器、管理许可、打开项目，Pipeline 包则把运行中的编辑器变成常驻本地服务，能在主线程毫秒级编译运行 C# 片段。",
  "provider": "youtube",
  "videoId": "EaEIynRqIHU",
  "channel": {
    "name": "Unity",
    "url": "https://www.youtube.com/@unity"
  },
  "categories": [
    "tutorial",
    "gamedev"
  ],
  "tags": [
    "unity",
    "cli",
    "automation",
    "agents"
  ],
  "duration": "7:06",
  "published": "2026-09-17T17:14:47+00:00",
  "lang": "en",
  "chapters": [
    {
      "t": "0:00",
      "label": "介绍"
    },
    {
      "t": "1:14",
      "label": "工作原理"
    },
    {
      "t": "2:08",
      "label": "安装"
    },
    {
      "t": "2:56",
      "label": "命令结构"
    },
    {
      "t": "4:06",
      "label": "能做什么"
    },
    {
      "t": "4:49",
      "label": "智能体接入"
    },
    {
      "t": "5:42",
      "label": "关于 Unity MCP"
    },
    {
      "t": "6:26",
      "label": "官方 Claude 插件"
    }
  ],
  "relatedTools": [
    "claude-code",
    "codex-cli",
    "cursor",
    "github-copilot"
  ],
  "featured": true,
  "lastChecked": "2026-10-25",
  "verifiedBy": "YouTube oEmbed（标题 / 频道 / 可嵌入）+ 频道 RSS（发布时间）+ 频道或播放列表页（时长）",
  "order": 23,
  "en": {
    "summary": "Unity's tutorial: the editor GUI is slow and token-hungry for AI automation. The new Unity CLI installs editors, manages licences and opens projects, while the Pipeline package turns a running editor into a local service that compiles and runs C# snippets on the main thread in milliseconds."
  }
}
---

<p>让 AI 去「看」编辑器界面、点按钮，是一种又慢又贵的自动化方式。这支七分钟的 Unity 官方教程介绍了另一条路：新的 Unity CLI 加上 Pipeline 包，让智能体绕过界面直接和编辑器交互。CLI 负责环境层面的事——安装编辑器、管理许可、打开项目；Pipeline 包则把正在运行的编辑器变成常驻内存的本地服务，域重载后依然在线，能在主线程上以毫秒级速度编译并运行 C# 代码片段。</p>
<p>视频演示了两条命令完成安装、如何读懂命令格式而不用死记语法，以及实时执行代码的效果。官方特别指出：任何能执行 shell 命令的智能体（比如 Claude Code、Codex、Cursor、Copilot）都能直接驱动 Unity，不需要额外配置；结尾还回答了「那 Unity MCP 怎么办」这个大家最关心的问题。</p>
<h3>看点</h3>
<ul><li>CLI（管环境）与 Pipeline 包（管运行中的编辑器）的分工。</li><li>常驻编辑器服务带来的毫秒级 C# 执行。</li><li>与 MCP 方案的关系，以及官方 Claude 插件。</li></ul>
