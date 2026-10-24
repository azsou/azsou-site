---
{
  "title": "Cline",
  "subtitle": "开源的编辑器内 AI 编程智能体",
  "summary": "开源的 AI 编程智能体，以插件形式运行在 VS Code、JetBrains 等编辑器里，也有命令行版本；每一步改动和命令都可审阅，模型自由选择。",
  "icon": {
    "src": "/ai/icons/cline.png",
    "variants": true
  },
  "developer": {
    "name": "Cline Bot Inc.",
    "url": "https://cline.bot/",
    "type": "third-party"
  },
  "categories": [
    "vibe-coding",
    "agent",
    "cli"
  ],
  "tags": [
    "vscode-extension",
    "agent",
    "open-source"
  ],
  "platforms": [
    {
      "os": "windows",
      "linkType": "store",
      "url": "https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev",
      "requirements": "VS Code 扩展（也可在 Cursor、JetBrains 中使用）"
    },
    {
      "os": "macos",
      "linkType": "store",
      "url": "https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev",
      "requirements": "VS Code 扩展"
    },
    {
      "os": "linux",
      "linkType": "store",
      "url": "https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev",
      "requirements": "VS Code 扩展"
    },
    {
      "os": "cli",
      "linkType": "official",
      "url": "https://cline.bot/",
      "requirements": "npm 全局安装"
    }
  ],
  "price": {
    "model": "free",
    "note": "插件免费，模型费用按你自己的 API Key 计算"
  },
  "license": "Apache-2.0",
  "openSource": true,
  "website": "https://cline.bot/",
  "sourceRepo": "https://github.com/cline/cline",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 9
}
---

<p>Cline 是开源社区里最活跃的编辑器智能体之一。安装插件后，它会在侧边栏里接收任务，先给出计划，再逐步创建、修改文件和运行终端命令；每一步都会请求你的确认，并以差异视图展示改动，适合想把控过程的开发者。</p>
<p>它不绑定任何模型：可以填入 Anthropic、OpenAI、Google、DeepSeek 等服务的 API Key，也可以走 OpenRouter 或本地模型。内置的 MCP 市场能一键安装常用服务器，让它连接浏览器、数据库或项目管理工具。</p>
<p>插件本身免费开源（Apache-2.0），花费取决于你使用的模型 API。长任务的 token 消耗较大，建议在设置里开启用量提示。</p>
<p class="muted">信息核对于 2026-10-25，价格、额度与平台支持以 <a href="https://cline.bot/" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
