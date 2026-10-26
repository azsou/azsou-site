---
{
  "title": "Service Worker 离线外壳：缓存策略与更新提示实测",
  "category": "开发实践",
  "badge": "实测",
  "author": "Randy Hopkins",
  "date": "2026-07-21",
  "lastChecked": "2026-07-21",
  "readingMinutes": 8,
  "toc": [
    "单文件站要什么缓存",
    "cache-first 的边界",
    "更新的两难",
    "file:// 的退化"
  ],
  "tags": [
    "dev-practice",
    "tested"
  ],
  "forumThread": "t-regression",
  "ogImage": "/og/sw-offline-shell.png",
  "art": null,
  "pinyin": "lxwkhccclygxtssc",
  "order": 5
}
---

<p>V58 给站点加了 Service Worker 离线外壳。单文件站点的缓存问题比多资源站简单得多，但「更新时机」的两难一点不少。这篇是部署套件里 az-sw.js 的设计说明与实测记录。</p><div class="callout"><b>结论：</b>单文件 + SW 的正确形态：外壳 cache-first 保离线，版本号进缓存名保更新，升级提示交给页面而不是静默换血。</div><h2 id="a-sec-1">单文件站要什么缓存</h2><p>整站就一个 HTML（外加 manifest/favicon），SHELL 列表三行写完。收益立竿见影：断网重开，站点完整可用——包括全部文章、作品与论坛种子。</p><h2 id="a-sec-2">cache-first 的边界</h2><p>cache-first 意味着上线新版后，老访客第一次打开仍是旧版。对个人站可接受；对时效内容不行。版本号写进缓存名（az-studio-v63），install 时旧缓存整体废弃，避免新旧混用。</p><h2 id="a-sec-3">更新的两难</h2><p>skipWaiting 立即接管会在用户浏览中途换代码；不接管则更新永远差一次刷新。折中：新 SW 就位后 postMessage 通知页面，页面弹一条「新版本已就绪」的 toast，刷新权交还用户。</p><h2 id="a-sec-4">file:// 的退化</h2><p>SW 不在 file:// 下工作，注册代码检测协议后静默跳过——双击打开的单文件体验不受影响，这正是「渐进增强」在部署层的含义。</p>
