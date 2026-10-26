---
{
  "title": "GitHub MCP Server",
  "subtitle": "GitHub 官方 MCP 服务器",
  "tagline": "GitHub 官方 MCP 服务器",
  "summary": "GitHub 官方的 MCP 服务器，让 AI 助手读取仓库代码、管理 Issue 与 Pull Request、查看 Actions 运行结果，可远程托管或本地运行。",
  "icon": {
    "src": "/ai/icons/github-mcp-server.png",
    "variants": true
  },
  "developer": {
    "name": "GitHub",
    "url": "https://github.com/",
    "type": "third-party"
  },
  "categories": [
    "mcp"
  ],
  "tags": [
    "mcp",
    "github",
    "open-source"
  ],
  "platforms": [
    {
      "os": "mcp",
      "linkType": "github",
      "url": "https://github.com/github/github-mcp-server",
      "requirements": "远程托管或本地 Docker / 二进制运行"
    }
  ],
  "price": {
    "model": "free",
    "note": "免费开源"
  },
  "license": "MIT",
  "openSource": true,
  "website": "https://github.com/github/github-mcp-server",
  "ai": {
    "mcp": "本身是 MCP 服务器"
  },
  "sourceRepo": "https://github.com/github/github-mcp-server",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 29,
  "en": {
    "subtitle": "GitHub's official MCP server",
    "summary": "GitHub's official MCP server lets AI assistants read repository code, manage issues and pull requests and check Actions runs through a standard protocol. Use the hosted version or run it locally."
  }
}
---

<p>GitHub MCP Server 是 GitHub 官方用 Go 编写并开源的 MCP 服务器。接入后，AI 助手可以直接搜索代码、读取文件、创建和评论 Issue、发起或审查 Pull Request、查看 Actions 工作流和安全告警，而不需要你在浏览器和编辑器之间来回复制。</p>
<p>它提供两种用法：GitHub 托管的远程服务器（通过 OAuth 授权，配置最简单），以及本地运行的版本（Docker 或二进制，使用个人访问令牌）。工具按功能分组，可以只开启需要的部分，并支持只读模式，降低误操作风险。</p>
<p>服务器本身免费开源（MIT），调用遵循 GitHub API 的权限与限流。建议为 AI 单独创建权限最小的访问令牌。</p>
<p class="muted">信息核对于 2026年10月25日，价格、额度与平台支持以 <a href="https://github.com/github/github-mcp-server" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
