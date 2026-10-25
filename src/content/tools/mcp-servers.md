---
{
  "title": "MCP 官方参考服务器",
  "subtitle": "Model Context Protocol 参考实现合集",
  "summary": "Model Context Protocol 官方维护的参考服务器合集，包含文件系统、Git、网页抓取、记忆等示例实现，是学习和搭建 MCP 服务器的起点。",
  "icon": {
    "src": "/ai/icons/mcp-servers.png",
    "variants": true
  },
  "developer": {
    "name": "Model Context Protocol 项目",
    "url": "https://modelcontextprotocol.io/",
    "type": "third-party"
  },
  "categories": [
    "mcp"
  ],
  "tags": [
    "mcp",
    "reference",
    "open-source"
  ],
  "platforms": [
    {
      "os": "mcp",
      "linkType": "github",
      "url": "https://github.com/modelcontextprotocol/servers",
      "requirements": "Node.js 或 Python（npx / uvx 运行）"
    }
  ],
  "price": {
    "model": "free",
    "note": "免费开源"
  },
  "license": "Apache-2.0 / MIT（许可迁移中）",
  "openSource": true,
  "website": "https://modelcontextprotocol.io/",
  "sourceRepo": "https://github.com/modelcontextprotocol/servers",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 28,
  "en": {
    "title": "MCP Reference Servers",
    "subtitle": "Model Context Protocol reference implementations",
    "summary": "The official collection of Model Context Protocol reference servers, with example implementations for the filesystem, Git, web fetching, memory and more — a starting point for learning and building MCP servers."
  }
}
---

<p>MCP（Model Context Protocol）是一个开放协议，规定了 AI 助手如何以统一方式调用外部工具和读取数据。这个仓库由协议官方维护，收录了一组参考服务器：文件系统读写、Git 操作、网页抓取（Fetch）、知识图谱式记忆、时间换算等。</p>
<p>它们的定位是「示例与起点」：代码简洁、行为清晰，适合用来理解 MCP 的工具、资源和提示词三种能力，也可以直接配置到 Claude、Cursor、Cline、goose 等支持 MCP 的客户端里使用。仓库的 README 还索引了大量第三方和官方集成服务器。</p>
<p>全部免费开源，项目正在把许可从 MIT 迁移到 Apache-2.0。参考服务器并非为生产环境设计，接入真实数据时请收紧权限，例如限制文件系统服务器可访问的目录。</p>
<p class="muted">信息核对于 2026-10-25，价格、额度与平台支持以 <a href="https://modelcontextprotocol.io/" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
