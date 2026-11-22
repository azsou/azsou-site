---
{
  "title": "美术向 MegaLights 指南（Unreal Engine 5.8）",
  "originalTitle": "Artist's Guide to Using MegaLights in Unreal Engine 5.8 | Inside Unreal",
  "summary": "Inside Unreal 直播回放：两位 Epic 讲师介绍 MegaLights 是什么、原理与设置方法，用 200 盏重叠投影灯做压力测试并对比关闭时的效果，演示车灯、天空与昼夜循环等真实场景的布光技巧，并回答大量观众提问。",
  "provider": "youtube",
  "videoId": "Nrb17mtBJPM",
  "channel": {
    "name": "Unreal Engine",
    "url": "https://www.youtube.com/@UnrealEngine"
  },
  "categories": [
    "gamedev"
  ],
  "tags": [
    "unreal",
    "lighting",
    "megalights"
  ],
  "duration": "2:46:36",
  "published": "2026-10-08T21:13:25+00:00",
  "lang": "en",
  "chapters": [
    {
      "t": "8:13",
      "label": "MegaLights 是什么：概览与核心概念"
    },
    {
      "t": "14:37",
      "label": "光照技术简史：顶点光照、烘焙与 Lumen"
    },
    {
      "t": "20:31",
      "label": "配置：项目设置与逐灯开关"
    },
    {
      "t": "24:16",
      "label": "灯光类型与衰减半径"
    },
    {
      "t": "27:00",
      "label": "每像素采样预算与光照复杂度视图"
    },
    {
      "t": "29:17",
      "label": "压力测试：200 盏重叠的投影灯"
    },
    {
      "t": "33:10",
      "label": "对比：同一场景关闭 MegaLights"
    },
    {
      "t": "44:07",
      "label": "自动缩放衰减的「智能灯」蓝图"
    },
    {
      "t": "59:37",
      "label": "问答第一轮"
    },
    {
      "t": "1:35:23",
      "label": "光照通道与灯光链接（5.8 新增）"
    },
    {
      "t": "1:52:55",
      "label": "用材质参数集合做昼夜循环"
    },
    {
      "t": "2:03:59",
      "label": "平行光最佳实践：为什么太阳不用 MegaLights"
    },
    {
      "t": "2:38:01",
      "label": "查看 MegaLights 的显存开销"
    },
    {
      "t": "2:43:13",
      "label": "最后问答：硬件光线追踪要求"
    }
  ],
  "lastChecked": "2026-10-25",
  "verifiedBy": "YouTube oEmbed（标题 / 频道 / 可嵌入）+ 频道 RSS（发布时间）+ 频道或播放列表页（时长）",
  "order": 15,
  "en": {
    "summary": "An Inside Unreal livestream: two Epic instructors explain what MegaLights is, how it works and how to set it up, stress-test it with 200 overlapping shadow-casting lights against the off state, show lighting for headlights, skies and day-night cycles, and answer many viewer questions."
  }
}
---

<p>MegaLights 让场景里可以放大量带阴影的动态光源，但「能放很多灯」不代表随便放。这期将近三小时的 Inside Unreal 直播由 Dan Hutnik 和 Daryl Obert 主讲，面向美术讲清楚它的原理、设置和布光习惯，无论你刚接触 UE5 光照还是已经很熟悉都适用。</p>
<p>直播很长，建议按章节跳着看：前一个小时讲概念、配置和压力测试（200 盏重叠投影灯与关闭 MegaLights 的对比非常直观）；中段是车辆大灯、IES 灯光文件、天空与昼夜循环等实战场景；后段集中回答静态光照、显存与硬件光追要求等问题。下方章节可以直接从对应时间点开始播放。</p>
<h3>看点</h3>
<ul><li>MegaLights 与烘焙光照、Lumen 的关系。</li><li>衰减半径、采样预算等关键参数的调法。</li><li>平行光为什么不建议交给 MegaLights，以及显存开销的检查方法。</li></ul>
