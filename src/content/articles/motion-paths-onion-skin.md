---
{
  "title": "运动路径、洋葱皮与关键帧交互",
  "category": "FableMotion",
  "badge": "原创技术文章",
  "author": "Randy Hopkins",
  "date": "2026-07-18",
  "lastChecked": "2026-07-19",
  "readingMinutes": 8,
  "toc": [
    "为什么路径要画在舞台上",
    "洋葱皮的采样策略",
    "拖拽关键帧的三条规则",
    "验收清单"
  ],
  "tags": [
    "fablemotion"
  ],
  "forumThread": "t-fm-timeline",
  "ogImage": "/og/motion-paths-onion-skin.png",
  "art": "article-motion",
  "pinyin": "ydljycpygjzjh",
  "order": 8
}
---

<p>S3 之前，运动路径只存在于数据里：想知道对象怎么走，要么按播放，要么读关键帧表。这次把路径直接画到舞台上，顺带把洋葱皮和关键帧拖拽也重做了一遍。</p><div class="callout"><b>结论：</b>路径、洋葱皮、关键帧三者共享同一份采样缓存。分开实现时它们各自都对，叠在一起就互相矛盾。</div><h2 id="a-sec-1">为什么路径要画在舞台上</h2><p>路径是位置属性的时间积分，画在舞台上才能一眼看出过冲和折返。实现上用 Graph Editor 的曲线求值器按帧采样，超过 240 帧自动降为二分抽样，保证 4 秒以上的动画路径也在 1ms 内画完。</p><h2 id="a-sec-2">洋葱皮的采样策略</h2><p>前后各 N 帧的残影不能逐帧渲染整个舞台——那是 N 倍开销。只对选中对象走轻量绘制路径：变换 + 轮廓，跳过滤镜和子对象展开。测试场景里 7 层洋葱皮的额外开销从 41ms 降到 6ms。</p><h2 id="a-sec-3">拖拽关键帧的三条规则</h2><ul><li>拖拽中只更新预览，不写入历史；松手才提交一条撤销记录</li><li>吸附到相邻关键帧与整数帧，按住 Alt 关闭吸附</li><li>多选拖拽保持相对间距，越界部分按边界钳制而不是丢弃</li></ul><pre><code>onDrag(frames =&gt; preview(frames));
onDrop(frames =&gt; store.dispatch({
  type: 'keyframes/move', payload: frames
}));</code></pre><h2 id="a-sec-4">验收清单</h2><ul><li>路径与实际播放轨迹逐帧一致（含缓动）</li><li>洋葱皮开关不改变最终渲染结果</li><li>拖拽过程中撤销栈长度不变，松手后恰好 +1</li></ul>
