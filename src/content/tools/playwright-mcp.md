---
{
  "title": "Playwright MCP",
  "subtitle": "让 AI 操作浏览器的 MCP 服务器",
  "tagline": "让 AI 操作浏览器的 MCP 服务器",
  "summary": "微软 Playwright 团队的官方 MCP 服务器，让 AI 助手通过结构化的无障碍快照操作浏览器：打开网页、点击、填表、截图和做端到端测试。",
  "icon": {
    "src": "/ai/icons/playwright-mcp.png",
    "variants": true
  },
  "developer": {
    "name": "Microsoft",
    "url": "https://playwright.dev/",
    "type": "third-party"
  },
  "categories": [
    "mcp"
  ],
  "tags": [
    "mcp",
    "browser-automation",
    "testing"
  ],
  "platforms": [
    {
      "os": "mcp",
      "linkType": "github",
      "url": "https://github.com/microsoft/playwright-mcp",
      "requirements": "Node.js（npx @playwright/mcp）"
    }
  ],
  "price": {
    "model": "free",
    "note": "免费开源"
  },
  "license": "Apache-2.0",
  "openSource": true,
  "website": "https://github.com/microsoft/playwright-mcp",
  "ai": {
    "mcp": "本身是 MCP 服务器"
  },
  "sourceRepo": "https://github.com/microsoft/playwright-mcp",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 30,
  "en": {
    "subtitle": "MCP server that lets AI drive a browser",
    "summary": "The Playwright team's official MCP server lets AI assistants operate a real browser through structured accessibility snapshots: open pages, click, fill forms, take screenshots and run end-to-end tests."
  }
}
---

<p>Playwright MCP 把成熟的浏览器自动化库 Playwright 包装成 MCP 服务器。和截图后让模型「看图点击」的方式不同，它把页面转换成无障碍树快照交给 AI，元素定位更稳定、消耗的 token 也更少，不依赖视觉模型。</p>
<p>配置到 Claude、Cursor、Cline、Codex 等客户端后，AI 就能替你打开网页、登录测试账号、填写表单、抓取信息或复现 Bug；对前端开发者来说，它还可以边操作边生成 Playwright 测试脚本。支持 Chromium、Firefox 和 WebKit，可无头运行。</p>
<p>免费开源（Apache-2.0）。让 AI 控制浏览器存在误操作风险，建议使用独立的浏览器配置文件，不要让它接触真实支付或重要账号。</p>
<p class="muted">信息核对于 2026年10月25日，价格、额度与平台支持以 <a href="https://github.com/microsoft/playwright-mcp" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
