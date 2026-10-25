---
{
  "title": "OpenAI Codex CLI",
  "subtitle": "OpenAI 开源的终端编程智能体",
  "summary": "OpenAI 开源的命令行编程智能体：在本地仓库里阅读代码、修改文件、运行命令和做代码审查，可用 ChatGPT 账号登录或使用 API Key。",
  "icon": {
    "src": "/ai/icons/codex-cli.png",
    "variants": true
  },
  "developer": {
    "name": "OpenAI",
    "url": "https://openai.com/",
    "type": "third-party"
  },
  "categories": [
    "cli",
    "agent"
  ],
  "tags": [
    "coding-agent",
    "terminal",
    "open-source"
  ],
  "platforms": [
    {
      "os": "cli",
      "linkType": "github",
      "url": "https://github.com/openai/codex/releases",
      "requirements": "macOS / Linux / Windows（另有 npm、Homebrew 安装方式）"
    }
  ],
  "price": {
    "model": "freemium",
    "note": "随 ChatGPT 套餐提供（额度按套餐），也可用 API Key 按量计费"
  },
  "license": "Apache-2.0",
  "openSource": true,
  "website": "https://learn.chatgpt.com/docs/codex/cli",
  "sourceRepo": "https://github.com/openai/codex",
  "featured": true,
  "lastChecked": "2026-10-25",
  "order": 2,
  "en": {
    "subtitle": "OpenAI's open-source terminal coding agent",
    "summary": "OpenAI's open-source command-line coding agent: it reads code, edits files, runs commands and reviews code in your local repo. Sign in with a ChatGPT account or use an API key."
  }
}
---

<p>Codex CLI 是 OpenAI 的开源终端智能体，用 Rust 编写，安装后在项目目录里输入 codex 即可开始。它能解释陌生代码、按要求重构、运行本地测试，也内置了对未提交改动或某个提交做审查的模式，输出按严重程度排序的问题清单。</p>
<p>它的权限模型比较细：可以选择只读、需要确认后才写文件，或在沙箱里自动执行；`codex exec` 适合放进脚本和 CI。和 Claude Code 类似，它支持 AGENTS.md 项目说明、技能与插件、MCP 服务器，也能把任务交给云端继续跑。</p>
<p>Codex 随 ChatGPT 各档套餐提供，额度按套餐而定；也可以改用 API Key 按 token 计费。源码以 Apache-2.0 开放，适合想审计或二次开发的团队。</p>
<p class="muted">信息核对于 2026-10-25，价格、额度与平台支持以 <a href="https://learn.chatgpt.com/docs/codex/cli" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
