---
{
  "title": "纯静态站点的严格 CSP：内联脚本哈希、独立策略与第三方脚本",
  "category": "开发实践",
  "badge": "原创",
  "author": "Randy Hopkins",
  "date": "2026-10-25",
  "lastChecked": "2026-10-25",
  "readingMinutes": 7,
  "toc": [
    "为什么静态站也需要严格 CSP",
    "没有 nonce：用内联脚本哈希",
    "需要放宽的地方，各自独立",
    "别给静态资源发 CSP",
    "接入第三方脚本时怎么办"
  ],
  "tags": [
    "dev-practice",
    "original"
  ],
  "forumThread": null,
  "ogImage": "/og/static-site-strict-csp.png",
  "art": null,
  "pinyin": "cjtzddygnljbhxdlclydsfjb",
  "order": 13,
  "description": "没有服务器也能做到不含 unsafe-inline 的 CSP：用内联脚本哈希代替 nonce，让构建产物与策略在 CI 里互相校验，WASM、CMS 与视频嵌入各用一条独立规则。"
}
---

<p>azsou.com v2 是一个纯静态站：Astro 构建出 HTML，部署在 Vercel，没有自己的应用服务器。很多人觉得静态站「没什么可攻击的」，用不着内容安全策略（CSP）。但站里有论坛、评论、留言板，用户写的内容会出现在页面上；只要渲染链路有一处疏漏，一段注入的脚本就能读走访客的登录会话。CSP 是最后一道防线：就算 HTML 里真的混进了 <code>&lt;script&gt;</code>，浏览器也拒绝执行。这篇记录本站把 CSP 做到「不含 unsafe-inline、不含 unsafe-eval」的过程，以及几处不得不单独处理的地方。</p><div class="callout"><b>结论：</b>静态站没有逐请求的 nonce，就用内联脚本的 SHA-256 哈希；让构建产物和策略互相校验（CI 里跑），而不是靠人记得改；需要放宽的地方（WASM、CMS、视频嵌入）各给一条独立规则，不要把整站策略拉低到最弱的那个页面。</div><h2 id="a-sec-1">为什么静态站也需要严格 CSP</h2><p>CSP 的核心是 <code>script-src</code>：它决定哪些脚本可以执行。最常见的「省事」写法是加上 <code>'unsafe-inline'</code>，这样所有内联脚本都能跑——包括攻击者注入的那一段，等于没设。本站的 <code>script-src</code> 只有三类来源：<code>'self'</code>（自己域名下的脚本文件）、若干个内联脚本的哈希、以及 Cloudflare Turnstile 的域名（注册、留言、订阅表单的人机验证）。</p><p>论坛和评论的正文本来就有两道防线：服务端存的是 Markdown，渲染器先转义所有 HTML 再生成白名单标签，浏览器端再经 DOMPurify 过一遍（渲染器的实现在仓库的 <code>src/lib/markdown.ts</code>）。CSP 是第三道：前两道都失手时，它保证注入的脚本不会执行。三道防线各自独立，任何一道单独出错都不至于出事，这比把希望押在某一道「绝对正确」上可靠得多。</p><h2 id="a-sec-2">没有 nonce：用内联脚本哈希</h2><p>Google 等厂商推荐的「严格 CSP」用 nonce：服务器每次响应生成一个随机值，写进响应头，也写进每个 <code>&lt;script nonce&gt;</code>。这要求每个请求都经过服务器，而纯静态站的 HTML 是构建时生成、由 CDN 原样返回的，同一个文件发给所有人，放不进随机值。</p><p>替代方案是哈希：CSP 允许写 <code>'sha256-…'</code>，浏览器计算内联脚本内容的 SHA-256，与策略里的值一致才执行。本站目前只有少数几段必须内联的脚本，比如首帧主题脚本——它要在页面绘制前读出访客选择的浅色 / 深色主题，放进外链文件就会闪一下，必须内联。这些脚本的哈希写在 <code>vercel.json</code> 的 CSP 头里。</p><p>哈希的麻烦在于：脚本改一个空格，哈希就变了，忘了更新策略，线上脚本就会被拦截——而且本地开发环境往往不带 CSP 头，发现不了。所以本站写了一个检查脚本 <code>scripts/check-csp.mjs</code>：遍历构建产物里的每个 HTML，提取全部内联脚本（JSON-LD 这类数据块除外），逐个计算哈希，与 <code>vercel.json</code> 里的值比对；缺一个就让 CI 失败。改了内联脚本之后跑一次 <code>npm run csp:update</code>，脚本会把新的哈希写回去，再提交。同一个脚本还会检查 HTML 里有没有 <code>onclick=</code> 这类内联事件处理器——它们无法用哈希放行，一旦出现就报错。</p><p>反过来也要查：策略里还留着已经不存在的哈希，说明有一段旧脚本被删了却没清理，脚本会给出警告。策略和代码双向一致，才算真的「可维护」。</p><h2 id="a-sec-3">需要放宽的地方，各自独立</h2><p>真实站点总有几个页面需要比全站更宽的权限。本站的做法是给它们单独一条响应头规则，而不是把全站策略放宽到满足最弱的那一页：</p><ul><li><strong>站内搜索的 Web Worker</strong>：Pagefind 用 WebAssembly 做中文分词和检索，需要 <code>'wasm-unsafe-eval'</code>。Worker 的 CSP 取自它自己的响应头，所以只给 <code>/pagefind/</code> 下的文件加这一项，并且 <code>default-src 'none'</code>，其余全部收紧；页面本身的策略里没有 WASM 权限。</li><li><strong>内容后台 /cms/</strong>：Decap CMS 的表单校验依赖 <code>eval</code>，只能给它一条带 <code>'unsafe-eval'</code> 的独立策略，同时 <code>frame-ancestors 'none'</code>，并在 robots 与 sitemap 里排除。只有站长会打开这个页面。</li><li><strong>视频嵌入</strong>：<code>frame-src</code> 只放 Turnstile 和 <code>www.youtube-nocookie.com</code>，不放 youtube.com 主站，不用通配符。检查脚本会读内容目录里实际用到的视频平台，用到哪个才允许哪个的嵌入域名，多放一个都会报错。视频页本身默认只显示本地缩略图，点击后才加载播放器（<a href="/videos/">视频栏目</a>就是这样做的）。</li></ul><p>有一个容易踩的坑：如果两条规则同时匹配同一个地址，浏览器会收到两个 CSP 头，两个策略叠加生效——结果是取交集，任何一边禁止的都被禁止。所以全站规则用负向前瞻排除掉这几个目录，检查脚本也会确认 <code>/pagefind/</code> 下的地址不会被页面规则匹配到。</p><h2 id="a-sec-4">别给静态资源发 CSP</h2><p>CSP 只对文档和 Worker 有意义。Astro 构建出的 <code>/_astro/</code> 目录里是带内容哈希的 JS 和 CSS，给它们发 CSP 头没有任何作用，却让每个响应多出七百字节左右的头部。Lighthouse 的资源预算按包含响应头在内的传输量计算，移动端慢速网络下这点开销会被放大。所以 CSP 规则排除 <code>/_astro/</code>，而 <code>nosniff</code>、Referrer-Policy、HSTS 这些对所有资源都有意义的头放在另一条全局规则里。</p><p>另一个细节是 <code>upgrade-insecure-requests</code>：线上是 HTTPS，这一条保证页面里偶尔混入的 http 链接被自动升级。但本地测试服务器跑在 http 上，这一条会把同源资源也升级成 https 而加载失败——本站的测试服务器（<code>scripts/serve.mjs</code>）在本地只去掉这一条，其余 CSP 原样生效，这样端到端测试跑的就是接近线上的策略。</p><h2 id="a-sec-5">接入第三方脚本时怎么办</h2><p>严格 CSP 最大的考验是第三方脚本，比如广告和统计。AdSense 的官方文档明确说只支持基于 nonce 的严格 CSP，原因是它会用到的域名会随时间变化，白名单迟早过时。对纯静态站，这意味着要么引入边缘函数为每个请求注入 nonce，要么接受一份需要维护的域名白名单。</p><p>本站选择的是后者，但做了两件事来控制风险：第一，Google 相关的来源默认完全不在策略里，只有站长设置了对应的环境变量、并用脚本显式打开时才加入；第二，打开和关闭由同一个函数完成，关闭后得到的策略与原来的严格策略逐字一致，检查脚本会验证这一点。更多关于广告接入前的隐私准备，见<a href="/articles/consent-mode-adsense-prep/">接入 AdSense 之前的准备清单</a>。</p><p>如果你也在维护一个单文件或纯静态的项目（比如<a href="/apps/single-file-toolbox/">单文件工具箱</a>这类下载即用的工具），同样的思路适用：内联脚本越少越好，必须内联的就算哈希，让构建和策略互相校验。CSP 不是一次性配置，而是一份需要测试守护的代码。</p>
