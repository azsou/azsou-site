---
{
  "title": "Ollama",
  "subtitle": "一条命令在本地运行大模型",
  "summary": "在自己电脑上运行开源大模型的工具：一条命令下载并启动 Llama、Qwen、DeepSeek 等模型，提供兼容 OpenAI 的本地 API，可接入各类 AI 应用。",
  "icon": {
    "src": "/ai/icons/ollama.png",
    "variants": true
  },
  "developer": {
    "name": "Ollama",
    "url": "https://ollama.com/",
    "type": "third-party"
  },
  "categories": [
    "cli",
    "ai-bot"
  ],
  "tags": [
    "local-llm",
    "open-source",
    "api"
  ],
  "platforms": [
    {
      "os": "macos",
      "linkType": "official",
      "url": "https://ollama.com/download"
    },
    {
      "os": "windows",
      "linkType": "official",
      "url": "https://ollama.com/download"
    },
    {
      "os": "linux",
      "linkType": "official",
      "url": "https://ollama.com/download",
      "requirements": "安装脚本：curl -fsSL https://ollama.com/install.sh | sh"
    }
  ],
  "price": {
    "model": "freemium",
    "note": "本地运行免费；官方云端模型另有付费套餐"
  },
  "license": "MIT",
  "openSource": true,
  "website": "https://ollama.com/",
  "sourceRepo": "https://github.com/ollama/ollama",
  "featured": true,
  "lastChecked": "2026-10-25",
  "order": 21
}
---

<p>Ollama 让「本地跑大模型」变得像安装一个软件一样简单：执行 ollama run 加上模型名，它会自动下载量化好的模型并启动对话。模型库里有大量开源模型，CPU、苹果芯片和 NVIDIA / AMD 显卡都能运行。</p>
<p>它更重要的价值是作为本地模型的「基础设施」：Ollama 在本机提供兼容 OpenAI 的 API，Open WebUI、Cline、Aider、goose、Dify 等工具都能直接把它当作模型后端，数据不出本机。新版本还提供桌面应用和可选的云端模型。</p>
<p>本地运行完全免费（MIT 开源），只受电脑性能限制；官方云端模型另有免费额度和付费套餐。显存越大，能跑的模型越大，一般 8GB 显存可流畅运行 7B–8B 级别的模型。</p>
<p class="muted">信息核对于 2026-10-25，价格、额度与平台支持以 <a href="https://ollama.com/" rel="noopener">官方网站</a> 为准。图标版权归各自所有者。</p>
