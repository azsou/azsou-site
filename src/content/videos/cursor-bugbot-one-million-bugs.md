---
{
  "title": "用 AI 修复一百万个 Bug：Cursor Bugbot",
  "originalTitle": "Fixing one million bugs with AI",
  "summary": "Cursor 介绍代码审查机器人 Bugbot：官方称它在一个月内从人工编写的 PR 里找出了一百多万个问题，其中过半是合并前就修掉的真实逻辑错误。视频讲它如何用多模型、加大算力和代码库理解来压低误报。",
  "provider": "youtube",
  "videoId": "7ytmiErmJ3U",
  "channel": {
    "name": "Cursor",
    "url": "https://www.youtube.com/@cursor_ai"
  },
  "categories": [
    "ai-coding"
  ],
  "tags": [
    "code-review",
    "bugbot",
    "pull-request"
  ],
  "duration": "1:54",
  "published": "2025-07-24T18:06:53+00:00",
  "lang": "en",
  "relatedTools": [
    "cursor",
    "github-copilot"
  ],
  "lastChecked": "2026-10-25",
  "verifiedBy": "YouTube oEmbed（标题 / 频道 / 可嵌入）+ 频道 RSS（发布时间）+ 频道或播放列表页（时长）",
  "order": 5
}
---

<p>AI 写代码越来越快，审查反而成了瓶颈。这支不到两分钟的官方视频介绍的 Bugbot 就是冲着这个问题来的：它在 PR 上自动审查，专门找「最难发现的逻辑错误」，并且刻意追求低误报——因为满屏噪音的审查意见最终只会被所有人忽略。</p>
<p>视频里的数字来自 Cursor 官方（一个月发现超过一百万个问题、过半是真实的逻辑问题并在合并前修复），本站无法独立核实，但它点出的方法值得参考：混合多个模型交叉判断、在审查上投入更多算力、结合对整个代码库的理解而不只看 diff。官方还提到不少团队已经把它设成合并前的必过检查。</p>
<h3>看点</h3>
<ul><li>为什么 AI 审查要优先优化「低误报」。</li><li>多模型 + 更多算力 + 代码库上下文的组合思路。</li><li>把 AI 审查放进合并前检查的团队实践。</li></ul>
