---
{
  "title": "讲透 Godot 的 LOD 与 HLOD",
  "originalTitle": "LODs demystified – Bart Wilmink – GodotCon 2026",
  "summary": "GodotCon 2026 技术分享：从 LOD、HLOD 的基础和常见坑讲起，覆盖交叉淡化的改进、由此带来的阴影问题与绕法、Godot 默认的球形近似选择方式（及其对宽屏游戏的影响）、ArrayMesh 的 LOD 参数和项目里的阈值像素设置。",
  "provider": "youtube",
  "videoId": "etvs8CynGqg",
  "channel": {
    "name": "Godot Engine",
    "url": "https://www.youtube.com/@GodotEngineOfficial"
  },
  "categories": [
    "gamedev"
  ],
  "tags": [
    "godot",
    "rendering",
    "optimization"
  ],
  "duration": "30:43",
  "published": "2026-06-03T18:00:30+00:00",
  "lang": "en",
  "lastChecked": "2026-10-25",
  "verifiedBy": "YouTube oEmbed（标题 / 频道 / 可嵌入）+ 频道 RSS（发布时间）+ 频道或播放列表页（时长）",
  "order": 10
}
---

<p>LOD（细节层次）是 3D 游戏优化里最常用、也最容易踩坑的技术之一。这场半小时的演讲由 Bart Wilmink 主讲，按他自己的说法，内容对新手友好，但也有老用户会感兴趣的细节。它最大的价值是把 Godot 引擎里那些「文档没写清楚」的行为可视化地讲出来。</p>
<p>演讲覆盖的点很具体：交叉淡化（cross-fade）怎么做得比默认方式更好、淡化导致的阴影问题如何绕开、Godot 默认用球形近似来选 LOD 对宽屏游戏意味着什么、ArrayMesh 的 add_surface 那个含糊的 LOD 参数实际怎么起作用，以及「阈值像素」项目设置和按物体 / 视口的 LOD 偏移。它也是作者另一场「百万棵树」演讲的前置知识。</p>
<h3>看点</h3>
<ul><li>LOD / HLOD 的基础与常见陷阱。</li><li>交叉淡化与阴影问题的处理办法。</li><li>可调的 LOD 选择参数及替代的选择算法演示。</li></ul>
