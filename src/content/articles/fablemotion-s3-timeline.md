---
{
  "title": "FableMotion S3：从模块化到时间轴终版 UI",
  "category": "FableMotion",
  "badge": "原创技术文章",
  "author": "Randy Hopkins",
  "date": "2026-07-19",
  "lastChecked": "2026-07-19",
  "readingMinutes": 12,
  "toc": [
    "问题是怎么形成的",
    "重构方式",
    "验收标准",
    "下一步"
  ],
  "tags": [
    "fablemotion"
  ],
  "forumThread": "t-fm-timeline",
  "ogImage": "/og/fablemotion-s3-timeline.png",
  "art": "article-featured",
  "pinyin": "cmkhdsjzzb",
  "order": 7
}
---

<p>这次迭代最难的不是实现新功能，而是阻止旧功能在合并时再次消失。时间轴、画布、关键帧和 Graph Editor 曾各自可用，但它们之间缺少清晰边界，导致一次局部修复就可能污染整条编辑链路。</p><div class="callout"><b>结论：</b>先冻结稳定基线，再让每个模块通过明确接口交换状态。复制整段 UI 模板修补，迟早会回归。</div><h2 id="a-sec-1">问题是怎么形成的</h2><p>早期版本把显示、状态和交互耦合在一起。时间轴重绘会顺带修改选区，选区变化又触发属性面板刷新，最后影响画布。看起来是一个按钮坏了，实际是状态流向没有边界。</p><h2 id="a-sec-2">重构方式</h2><p>项目状态、历史记录、播放控制和关键帧计算进入核心层，UI 只订阅状态并派发动作。Graph Editor 不再直接改 DOM，而是提交曲线变化，再由统一渲染流程更新所有视图。</p><pre><code>store.dispatch({
  type: 'keyframe/update-easing',
  payload: { trackId, keyframeId, easing }
});

renderTimeline(store.state);
renderStage(store.state);</code></pre><h2 id="a-sec-3">验收标准</h2><ul><li>拖动关键帧时，画布和属性面板同步更新</li><li>撤销与重做覆盖时间轴、曲线和对象属性</li><li>导入旧项目不会丢失轨道和 easing 数据</li><li>Win11 Chrome 与 Edge 完成同一套回归</li></ul><h2 id="a-sec-4">下一步</h2><p>正式站会让文章关联项目版本和已知问题，访客可以沿着时间线查看代码、失败记录和最终验收证据。</p>
