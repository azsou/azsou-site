---
{
  "title": "CSS @layer 迁移：从 3473 个 !important 到 0",
  "category": "开发实践",
  "badge": "复盘",
  "author": "Randy Hopkins",
  "date": "2026-07-22",
  "lastChecked": "2026-07-22",
  "readingMinutes": 11,
  "toc": [
    "债是怎么欠下的",
    "层序替代重要性",
    "最后 20 个的处理",
    "验收方式"
  ],
  "tags": [
    "dev-practice",
    "retrospective"
  ],
  "forumThread": "t-regression",
  "ogImage": "/og/layer-migration-zero-important.png",
  "art": null,
  "pinyin": "qycqydldl",
  "order": 4
}
---

<p>V52 期站点样式膨胀到 28 个补丁层、3473 个 !important。V53 归并砍掉九成，V55 用 @layer 收编剩余，V60.1 清到 0。这篇复盘完整路径。</p><div class="callout"><b>结论：</b>!important 的本质是「没有层序管理时的最后手段」。@layer 把优先级变成结构问题：未分层覆盖区永远压过分层基线，重要性标记就失去了存在理由。</div><h2 id="a-sec-1">债是怎么欠下的</h2><p>逐版本补丁模式下，每个新层都要压过旧层的同名规则，最快的武器就是 !important——于是它以复利增长：你的下一个补丁要压过上一个补丁的 !important，只能再加一层。</p><h2 id="a-sec-2">层序替代重要性</h2><p>V55 把基线放进 @layer az-base，覆盖规则放在未分层区。CSS 规定未分层样式在层序里天然最高——同一条规则不需要任何标记就能压过基线，历史包袱一次性变成结构。</p><h2 id="a-sec-3">最后 20 个的处理</h2><p>剩下的硬骨头分两类：对抗内联样式的（13 个）——把内联样式本身改成工具类，对抗随之消失；容器查询里压层内规则的（1 个）——把它搬进未分层区靠层序取胜。逐个消解，不留白名单。</p><h2 id="a-sec-4">验收方式</h2><p>每一步都过全组合几何矩阵：断点 × 密度 × 视图 × 主题 × 面板态逐元素比对，非意图差异为 0 才算完成。清零不是 grep 数字归零，是渲染结果逐像素等价前提下的归零。</p>
