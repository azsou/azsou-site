# 图标与品牌资产登记（D04）

> 由 `node scripts/design/icon-licenses.mjs` 生成，勿手改；新增图标后重新生成。

## UI 图标

| 来源                    | 版本    | 许可                                                  | 位置                                                                      |
| ----------------------- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Lucide（lucide-static） | 0.462.0 | ISC                                                   | `src/lib/lucide.ts`（子集，24 网格、描边 1.75、round 端点、currentColor） |
| GitHub 标志（填充字标） | —       | GitHub 商标，按其 Logo 使用规范仅用于指向 GitHub 链接 | `src/components/Icon.astro`                                               |

- 不使用 SF Symbols、不打包 Apple 字体或其它 Apple 专有资产；字体走系统字体栈。
- 搜索结果行的类型图标（`src/scripts/search/render.ts` 的 TYPE_ICON）与 `src/lib/lucide.ts` 逐字一致，由 `tests/unit/icons.test.ts` 校验。

## 应用与品牌图标（38 个，来自 `src/data/icon-manifest.json`）

| 标识                    | 类型           | 路径                              | 来源                                        | 许可 / 使用条件                                                  |
| ----------------------- | -------------- | --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `aider`                 | 第三方 AI 工具 | /ai/icons/aider                   | https://aider.chat/                         | 商标归 Aider-AI 所有，仅用于识别                                 |
| `bolt-new`              | 第三方 AI 工具 | /ai/icons/bolt-new                | https://bolt.new/                           | 商标归 StackBlitz 所有，仅用于识别                               |
| `capture-kit`           | 自研应用       | /apps/icons/capture-kit           | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `chatgpt`               | 第三方 AI 工具 | /ai/icons/chatgpt                 | https://chatgpt.com/                        | 商标归 OpenAI 所有，仅用于识别                                   |
| `claude`                | 第三方 AI 工具 | /ai/icons/claude                  | https://claude.com/                         | 商标归 Anthropic 所有，仅用于识别                                |
| `claude-code`           | 第三方 AI 工具 | /ai/icons/claude-code             | https://claude.com/product/claude-code      | 商标归 Anthropic 所有，仅用于识别                                |
| `cline`                 | 第三方 AI 工具 | /ai/icons/cline                   | https://cline.bot/                          | 商标归 Cline Bot Inc. 所有，仅用于识别                           |
| `codex-cli`             | 第三方 AI 工具 | /ai/icons/codex-cli               | https://learn.chatgpt.com/docs/codex/cli    | 商标归 OpenAI 所有，仅用于识别                                   |
| `coze`                  | 第三方 AI 工具 | /ai/icons/coze                    | https://www.coze.cn/                        | 商标归 ByteDance（字节跳动） 所有，仅用于识别                    |
| `cursor`                | 第三方 AI 工具 | /ai/icons/cursor                  | https://cursor.com/                         | 商标归 Anysphere 所有，仅用于识别                                |
| `deepseek`              | 第三方 AI 工具 | /ai/icons/deepseek                | https://www.deepseek.com/                   | 商标归 杭州深度求索人工智能基础技术研究有限公司 所有，仅用于识别 |
| `devin-desktop`         | 第三方 AI 工具 | /ai/icons/devin-desktop           | https://devin.ai/desktop                    | 商标归 Cognition 所有，仅用于识别                                |
| `dify`                  | 第三方 AI 工具 | /ai/icons/dify                    | https://dify.ai/                            | 商标归 LangGenius 所有，仅用于识别                               |
| `fablemotion`           | 自研应用       | /apps/icons/fablemotion           | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `gemini`                | 第三方 AI 工具 | /ai/icons/gemini                  | https://gemini.google.com/                  | 商标归 Google 所有，仅用于识别                                   |
| `gemini-cli`            | 第三方 AI 工具 | /ai/icons/gemini-cli              | https://geminicli.com/                      | 商标归 Google 所有，仅用于识别                                   |
| `github-copilot`        | 第三方 AI 工具 | /ai/icons/github-copilot          | https://github.com/features/copilot         | 商标归 GitHub（Microsoft） 所有，仅用于识别                      |
| `github-mcp-server`     | 第三方 AI 工具 | /ai/icons/github-mcp-server       | https://github.com/github/github-mcp-server | 商标归 GitHub 所有，仅用于识别                                   |
| `goose`                 | 第三方 AI 工具 | /ai/icons/goose                   | https://goose-docs.ai/                      | 商标归 Agentic AI Foundation（Linux 基金会） 所有，仅用于识别    |
| `hermes`                | 自研应用       | /apps/icons/hermes                | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `image-atlas-pro`       | 自研应用       | /apps/icons/image-atlas-pro       | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `kiro`                  | 第三方 AI 工具 | /ai/icons/kiro                    | https://kiro.dev/                           | 商标归 Amazon Web Services 所有，仅用于识别                      |
| `lm-studio`             | 第三方 AI 工具 | /ai/icons/lm-studio               | https://lmstudio.ai/                        | 商标归 Element Labs 所有，仅用于识别                             |
| `lovable`               | 第三方 AI 工具 | /ai/icons/lovable                 | https://lovable.dev/                        | 商标归 Lovable 所有，仅用于识别                                  |
| `mcp-servers`           | 第三方 AI 工具 | /ai/icons/mcp-servers             | https://modelcontextprotocol.io/            | 商标归 Model Context Protocol 项目 所有，仅用于识别              |
| `n8n`                   | 第三方 AI 工具 | /ai/icons/n8n                     | https://n8n.io/                             | 商标归 n8n GmbH 所有，仅用于识别                                 |
| `ollama`                | 第三方 AI 工具 | /ai/icons/ollama                  | https://ollama.com/                         | 商标归 Ollama 所有，仅用于识别                                   |
| `open-webui`            | 第三方 AI 工具 | /ai/icons/open-webui              | https://openwebui.com/                      | 商标归 Open WebUI Inc. 所有，仅用于识别                          |
| `openhands`             | 第三方 AI 工具 | /ai/icons/openhands               | https://www.openhands.dev/                  | 商标归 OpenHands 所有，仅用于识别                                |
| `playwright-mcp`        | 第三方 AI 工具 | /ai/icons/playwright-mcp          | https://github.com/microsoft/playwright-mcp | 商标归 Microsoft 所有，仅用于识别                                |
| `procedural-soundfield` | 自研应用       | /apps/icons/procedural-soundfield | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `replit-agent`          | 第三方 AI 工具 | /ai/icons/replit-agent            | https://replit.com/products/agent           | 商标归 Replit 所有，仅用于识别                                   |
| `single-file-toolbox`   | 自研应用       | /apps/icons/single-file-toolbox   | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `skill-tree-tool`       | 自研应用       | /apps/icons/skill-tree-tool       | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `sub2api`               | 自研应用       | /apps/icons/sub2api               | AZ Studio 原创（本仓库 scripts/icons）      | 保留所有权利                                                     |
| `trae`                  | 第三方 AI 工具 | /ai/icons/trae                    | https://www.trae.ai/                        | 商标归 ByteDance（字节跳动） 所有，仅用于识别                    |
| `v0`                    | 第三方 AI 工具 | /ai/icons/v0                      | https://v0.app/                             | 商标归 Vercel 所有，仅用于识别                                   |
| `zed`                   | 第三方 AI 工具 | /ai/icons/zed                     | https://zed.dev/                            | 商标归 Zed Industries 所有，仅用于识别                           |

来源为「待补」或只给出官网首页的条目，具体取图页面未逐个记录：**待站长确认**是否需要逐个补记取图链接与日期。
