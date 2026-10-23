---
{
  "title": "Chrome MV3 动态域名授权与用户激活",
  "category": "浏览器扩展",
  "badge": "实测记录",
  "author": "Randy Hopkins",
  "date": "2026-07-18",
  "lastChecked": "2026-07-18",
  "readingMinutes": 11,
  "toc": [
    "为什么不能预授权",
    "用户激活链路",
    "失败的两种绕法",
    "上架审查结论"
  ],
  "tags": [
    "browser-extension"
  ],
  "forumThread": "t-mv3-ux",
  "ogImage": "/og/chrome-mv3-domain-activation.png",
  "art": "article-extension",
  "pinyin": "dtymsqyyhjh",
  "order": 9
}
---

<p>Image Atlas 需要在用户点开陌生图床时请求该域名的读取权限。MV3 之下这件事只有一条合法路径：<code>permissions.request</code> 必须发生在用户手势的同步调用栈里。任何"提前想好"的设计都会碰壁。</p><div class="callout"><b>结论：</b>把授权请求留在用户点击的那一帧，其余全部按"没有权限"设计。体验反而更稳定，审查也一次通过。</div><h2 id="a-sec-1">为什么不能预授权</h2><p><code>host_permissions</code> 里的通配域名会在安装时吓退用户，也让商店审查进入人工队列。实测同一个扩展，通配版本审查用了 11 天并被要求书面说明，白名单版本 36 小时过审。</p><h2 id="a-sec-2">用户激活链路</h2><p>点击卡片 → 同步调用 <code>permissions.request({origins:[origin]})</code> → resolve 后才发起抓取。中间任何一次 <code>await</code> 都会丢失激活状态，Chrome 118 之后直接静默拒绝。</p><pre><code>button.addEventListener('click', () =&gt; {
  chrome.permissions.request(
    { origins: [new URL(src).origin + '/*'] },
    granted =&gt; granted &amp;&amp; scan(src)
  );
});</code></pre><h2 id="a-sec-3">失败的两种绕法</h2><p>试过把请求挂在 hover 上（被判定非显式手势）和用 offscreen document 代理（权限模型直接不认）。两条路都留下了回归测试，防止未来"优化"回去。</p><h2 id="a-sec-4">上架审查结论</h2><ul><li>权限请求全部可追溯到用户点击，审查一次通过</li><li>拒绝授权后的降级路径必须可用，这是审查员实际点过的地方</li><li>权限说明文案与行为逐条对应，避免二次问询</li></ul>
