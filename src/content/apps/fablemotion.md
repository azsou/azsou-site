---
{
  "title": "FableMotion",
  "subtitle": "时间轴与关键帧动画编辑器",
  "tagline": "时间轴与关键帧动画编辑器",
  "summary": "面向时间轴与关键帧创作的动画和视频编辑器，支持运动路径、Graph Editor 与视频导出，提供网页版和 Windows 版。",
  "icon": {
    "src": "/apps/icons/fablemotion.png",
    "placeholder": false,
    "variants": true
  },
  "hue": "purple",
  "developer": {
    "name": "Randy Hopkins",
    "url": "/about/",
    "type": "self"
  },
  "category": "creative",
  "tags": [
    "animation",
    "timeline",
    "video"
  ],
  "platforms": [
    {
      "os": "web",
      "version": "S3 Candidate",
      "linkType": "official",
      "requirements": "Chrome / Edge（作者测试环境）",
      "availability": "coming-soon"
    },
    {
      "os": "windows",
      "version": "S3 Candidate",
      "linkType": "official",
      "requirements": "Windows 11（作者测试环境：Win11 Chrome / Edge）",
      "availability": "coming-soon"
    }
  ],
  "screenshots": [
    {
      "src": "/apps/screens/fablemotion/timeline.webp",
      "alt": "FableMotion 概念图：舞台、图层面板、属性检查器与带关键帧的时间轴",
      "device": "desktop",
      "width": 1312,
      "height": 816,
      "illustrative": true
    },
    {
      "src": "/apps/screens/fablemotion/graph-editor.webp",
      "alt": "FableMotion 概念图：Graph Editor 中的贝塞尔动画曲线",
      "device": "desktop",
      "width": 1312,
      "height": 816,
      "illustrative": true
    },
    {
      "src": "/apps/screens/fablemotion/export.webp",
      "alt": "FableMotion 概念图：视频导出对话框与进度",
      "device": "desktop",
      "width": 1312,
      "height": 816,
      "illustrative": true
    }
  ],
  "price": {
    "model": "free"
  },
  "license": "保留所有权利（免费使用）",
  "openSource": false,
  "privacy": {
    "collects": [],
    "note": "本应用不收集个人数据，所有处理在本地完成。（默认说明，作者可更正）"
  },
  "changelog": [
    {
      "version": "S3 Candidate",
      "date": "2026-07-19",
      "notes": [
        "时间轴、画布和 Graph Editor 完成合流，进入最终验收。",
        "修复时间轴交互与导出"
      ]
    },
    {
      "version": "S3 Batch 3",
      "date": "2026-07-17",
      "notes": [
        "完善时间轴与终版 UI，修复导出链路。"
      ]
    },
    {
      "version": "S3 Foundation",
      "date": "2026-07-14",
      "notes": [
        "建立模块边界、工程配置和基础测试。"
      ]
    }
  ],
  "faq": [
    {
      "q": "支持哪些平台？",
      "a": "目前面向网页版与 Windows，作者的测试环境是 Win11 上的 Chrome / Edge。"
    },
    {
      "q": "可以在手机上编辑吗？",
      "a": "移动端编辑仍在验证中，暂不建议在手机上做正式项目。"
    },
    {
      "q": "现在能下载吗？",
      "a": "S3 仍处于最终验收（Candidate）阶段，下载按钮暂时显示「即将推出」。点按钮旁的「上线通知」订阅本站 RSS，或在页面底部留言，安装包公布后会第一时间更新。"
    }
  ],
  "featured": true,
  "updated": "2026-07-19",
  "version": "S3 Candidate",
  "status": "活跃开发",
  "statusClass": "active",
  "order": 1,
  "pinyin": "",
  "art": "hero-1",
  "lastChecked": "2026-07-19",
  "relatedArticles": [
    "fablemotion-s3-timeline",
    "motion-paths-onion-skin"
  ],
  "verification": [
    {
      "label": "源码来源",
      "value": "原创",
      "note": "项目代码与开发日志由作者维护"
    },
    {
      "label": "运行验证",
      "value": "进行中",
      "note": "Win11 Chrome / Edge 回归"
    },
    {
      "label": "发布状态",
      "value": "候选",
      "note": "不使用虚假“安全认证”徽章"
    }
  ],
  "issues": "真实媒体导出、复杂时间轴压力测试和移动端编辑仍需继续验证。所有状态以实际测试记录为准。",
  "ownerReview": false,
  "ownerTodo": [
    "真实下载地址（每个平台的官方 / 商店 / GitHub Release 链接；直链附 SHA-256）",
    "可选：真实截图（替换当前的概念图）",
    "核对默认值：价格「免费」、许可「保留所有权利（免费使用）」、不开源、隐私说明、平台"
  ],
  "en": {
    "subtitle": "Timeline and keyframe animation editor",
    "summary": "An animation and video editor built around timelines and keyframes."
  }
}
---

<p>FableMotion 面向时间轴动画、关键帧、运动路径和视频导出。S3 的目标不是继续堆功能，而是把画布、时间轴、Dopesheet、Graph Editor 和导出流程合并为稳定基线。</p>
<h2>当前能力</h2>
<ul>
<li>时间轴、关键帧与多轨道编辑</li>
<li>运动路径、洋葱皮与 Graph Editor</li>
<li>对象列表、属性面板与舞台直接交互</li>
<li>项目导入导出、撤销重做与 Hermes 验收</li>
</ul>
