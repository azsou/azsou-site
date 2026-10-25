---
{
  "title": "LM Studio",
  "subtitle": "图形界面的本地大模型工作台",
  "tagline": "图形界面的本地大模型工作台",
  "summary": "在电脑上下载和运行本地大模型的桌面应用：图形界面搜索模型、离线聊天、加载文档，并提供本地 API 服务器；新推出 Bionic 本地智能体。",
  "icon": {
    "src": "/ai/icons/lm-studio.png",
    "variants": true
  },
  "developer": {
    "name": "Element Labs",
    "url": "https://lmstudio.ai/",
    "type": "third-party"
  },
  "categories": [
    "ai-bot",
    "cli"
  ],
  "tags": [
    "local-llm",
    "desktop",
    "gui"
  ],
  "platforms": [
    {
      "os": "macos",
      "linkType": "official",
      "url": "https://lmstudio.ai/download"
    },
    {
      "os": "windows",
      "linkType": "official",
      "url": "https://lmstudio.ai/download"
    },
    {
      "os": "linux",
      "linkType": "official",
      "url": "https://lmstudio.ai/download"
    },
    {
      "os": "cli",
      "linkType": "github",
      "url": "https://github.com/lmstudio-ai/lms",
      "requirements": "lms 命令行（MIT 开源）"
    }
  ],
  "price": {
    "model": "freemium",
    "note": "本地运行免费；云端模型服务按月订阅"
  },
  "license": "专有软件（lms 命令行为 MIT）",
  "openSource": false,
  "website": "https://lmstudio.ai/",
  "sourceRepo": "https://github.com/lmstudio-ai/lms",
  "featured": false,
  "lastChecked": "2026-10-25",
  "order": 22,
  "en": {
    "subtitle": "Desktop workbench for local LLMs",
    "summary": "A desktop app for downloading and running LLMs on your own computer: search models in a GUI, chat offline, load documents and serve a local API. Now also ships Bionic, a local agent."
  }
}
---

<p>LM Studio 是不想碰命令行的人运行本地模型的首选。打开应用就能搜索和下载模型，界面会提示每个版本需要多少内存；下载后即可离线聊天，还能把 PDF 等文档拖进对话里提问。</p>
<p>它同时是一个开发工具：内置兼容 OpenAI 的本地服务器，可以给其他应用提供模型；命令行工具 lms 和无界面守护进程适合在服务器或 CI 中使用。在苹果芯片上它支持 MLX 引擎，速度表现很好。最近它还推出了面向本地模型的智能体应用 Bionic。</p>
<p>本地运行免费，可选的云端开源模型服务按月订阅。桌面应用闭源，命令行工具开源。</p>
<p class="muted">信息核对于 2026年10月25日，价格、额度与平台支持以 <a href="https://lmstudio.ai/" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
