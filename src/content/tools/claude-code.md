---
{
  "title": "Claude Code",
  "subtitle": "Anthropic 的终端编程智能体",
  "summary": "Anthropic 出品的编程智能体：在终端、IDE、桌面应用和网页里读懂整个代码库，改文件、跑命令、提交代码，并能通过 MCP 接入外部工具。",
  "icon": {
    "src": "/ai/icons/claude-code.png",
    "variants": true
  },
  "hue": "orange",
  "developer": {
    "name": "Anthropic",
    "url": "https://www.anthropic.com/",
    "type": "third-party"
  },
  "categories": [
    "cli",
    "agent",
    "vibe-coding"
  ],
  "tags": [
    "coding-agent",
    "terminal",
    "anthropic"
  ],
  "platforms": [
    {
      "os": "cli",
      "linkType": "official",
      "url": "https://code.claude.com/docs/en/overview",
      "requirements": "macOS / Linux / Windows（PowerShell 或 WSL）"
    },
    {
      "os": "web",
      "linkType": "web",
      "url": "https://claude.com/product/claude-code",
      "requirements": "浏览器（需登录 Claude 账号）"
    }
  ],
  "price": {
    "model": "paid",
    "note": "需要 Claude 付费订阅或 Anthropic API 账户（按量计费）"
  },
  "license": "专有软件（Anthropic 商业条款）",
  "openSource": false,
  "website": "https://claude.com/product/claude-code",
  "sourceRepo": "https://github.com/anthropics/claude-code",
  "featured": true,
  "lastChecked": "2026-10-25",
  "order": 1,
  "en": {
    "subtitle": "Anthropic's agentic coding tool",
    "summary": "Anthropic's coding agent: it understands your whole codebase in the terminal, IDE, desktop app or browser, edits files, runs commands, makes commits and connects to external tools through MCP."
  }
}
---

<p>Claude Code 是 Anthropic 推出的「智能体式」编程工具。和只补全一行代码的助手不同，它会先阅读项目结构，再规划改动、跨多个文件编辑、运行测试和命令，最后整理成提交或 Pull Request。除了终端版本，它也提供 VS Code / JetBrains 插件、桌面应用和网页版，几个入口共用同一套项目配置。</p>
<p>实际使用中最顺手的是它的可配置性：在项目根目录写一份 CLAUDE.md 说明代码规范，就能让每次会话都遵守；技能（skills）、钩子（hooks）和子智能体可以把重复流程固化下来；MCP 让它读取 Issue、文档或数据库。命令行模式还能接进 CI，用来批量审查改动或修复 lint。</p>
<p>需要注意它不是免费工具：大多数入口需要 Claude 付费订阅或 Anthropic API 账户，长任务消耗的额度不小。它会直接改动你的文件和执行命令，建议在 Git 仓库里使用、先看清权限提示再批准。</p>
<p class="muted">信息核对于 2026-10-25，价格、额度与平台支持以 <a href="https://claude.com/product/claude-code" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
