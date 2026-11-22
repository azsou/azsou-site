---
{
  "title": "跨域 frame 扫描如何避免拖垮主流程",
  "category": "浏览器扩展",
  "badge": "实测记录",
  "author": "Randy Hopkins",
  "date": "2026-07-17",
  "lastChecked": "2026-07-18",
  "readingMinutes": 9,
  "toc": [
    "问题：一个页面几十个 frame",
    "分层扫描队列",
    "失败隔离",
    "实测数字"
  ],
  "tags": [
    "browser-extension"
  ],
  "forumThread": "t-mv3-ux",
  "ogImage": "/og/cross-origin-frame-scan.png",
  "art": null,
  "pinyin": "kysmrhbmtkzlc",
  "order": 10
}
---

<p>Image Atlas 要在任意页面上找图，而真实页面平均带着十几个跨域 iframe——广告位、嵌入播放器、评论区。第一版把它们串行扫完，主页面的扫描结果要等 6 秒才出来。</p><div class="callout"><b>结论：</b>把"扫得全"和"扫得快"拆成两个队列：主文档即时返回，frame 结果流式补充。用户 300ms 内看到第一批图，剩下的陆续到。</div><h2 id="a-sec-1">问题：一个页面几十个 frame</h2><p>实测新闻站首页：14 个 iframe，其中 9 个跨域。逐个 executeScript 平均 380ms，串行就是 3.4 秒起步，还没算失败重试。</p><h2 id="a-sec-2">分层扫描队列</h2><p>主文档扫描立即执行并返回；frame 扫描进低优先级队列，三个并发，结果通过 port 流式推送到面板去重合并。面板先渲染主文档结果，frame 图片带着来源标记逐条插入。</p><pre><code>const queue = new TaskQueue({ concurrency: 3 });
frames.forEach(f =&gt; queue.push(() =&gt; scanFrame(f)));
queue.onResult(r =&gt; port.postMessage(r));</code></pre><h2 id="a-sec-3">失败隔离</h2><p>沙箱 frame、about:blank、失去响应的第三方页——任何一个失败都不该影响其余。每个任务 1.5s 超时，失败只记录不重试（重试留给用户手动刷新），面板上以"n 个来源不可读"的中性提示汇总。</p><h2 id="a-sec-4">实测数字</h2><ul><li>首批结果时间：3.4s → 0.3s</li><li>全量完成时间：6.1s → 2.2s（3 并发）</li><li>单 frame 失败对整体的影响：无（此前会卡住整条链）</li></ul>
