---
{
  "title": "goose",
  "subtitle": "本地运行的开源通用 AI 智能体",
  "tagline": "本地运行的开源通用 AI 智能体",
  "summary": "开源的本地 AI 智能体，提供桌面应用、命令行和 API，可接入 15 种以上模型服务与大量 MCP 扩展，用于编程、调研、写作和自动化。",
  "icon": {
    "src": "/ai/icons/goose.png",
    "variants": true
  },
  "developer": {
    "name": "Agentic AI Foundation（Linux 基金会）",
    "en": "Agentic AI Foundation (Linux Foundation)",
    "short": "AAIF（Linux 基金会）",
    "url": "https://goose-docs.ai/",
    "type": "third-party"
  },
  "categories": [
    "agent",
    "cli",
    "mcp"
  ],
  "tags": [
    "general-agent",
    "desktop",
    "open-source"
  ],
  "platforms": [
    {
      "os": "cli",
      "linkType": "github",
      "url": "https://github.com/aaif-goose/goose/releases",
      "requirements": "macOS / Linux / Windows"
    },
    {
      "os": "macos",
      "linkType": "official",
      "url": "https://goose-docs.ai/docs/getting-started/installation",
      "requirements": "桌面应用"
    },
    {
      "os": "windows",
      "linkType": "official",
      "url": "https://goose-docs.ai/docs/getting-started/installation",
      "requirements": "桌面应用"
    },
    {
      "os": "linux",
      "linkType": "official",
      "url": "https://goose-docs.ai/docs/getting-started/installation",
      "requirements": "桌面应用"
    }
  ],
  "price": {
    "model": "free",
    "note": "软件免费，模型费用取决于所接入的服务"
  },
  "license": "Apache-2.0",
  "openSource": true,
  "website": "https://goose-docs.ai/",
  "sourceRepo": "https://github.com/aaif-goose/goose",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 5,
  "en": {
    "subtitle": "Open-source general AI agent that runs locally",
    "summary": "An open-source local AI agent with a desktop app, CLI and API. Connects to 15+ model providers and many MCP extensions for coding, research, writing and automation."
  }
}
---

<p>goose 最初由 Block 开源，现在是 Linux 基金会旗下 Agentic AI Foundation 的项目。它定位为通用智能体：不只写代码，也能做资料整理、数据分析和日常自动化。用 Rust 编写，同时提供原生桌面应用和完整的命令行。</p>
<p>它把「能做什么」交给 MCP 扩展：连接文件系统、浏览器、GitHub、数据库等扩展后，goose 就能调用这些工具完成多步骤任务。模型方面可以用各家 API Key，也能通过 ACP 复用已有的 Claude、ChatGPT 或 Gemini 订阅，或连接本地的 Ollama。</p>
<p>软件本身免费开源，成本取决于所选模型。由于它能执行命令、读写本地文件，建议先在测试目录里熟悉权限设置。</p>
<p class="muted">信息核对于 2026年10月25日，价格、额度与平台支持以 <a href="https://goose-docs.ai/" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
