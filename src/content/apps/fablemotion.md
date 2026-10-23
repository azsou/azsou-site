---
{
  "title": "FableMotion",
  "kind": "创作工具",
  "icon": "FM",
  "hue": "accent",
  "summary": "动画与视频编辑器，面向时间轴和关键帧创作。",
  "version": "S3 Candidate",
  "status": "活跃开发",
  "statusClass": "active",
  "order": 1,
  "pinyin": "",
  "art": "hero-1",
  "lastChecked": "2026-07-19",
  "platform": "Web / Windows",
  "testEnv": "Chrome / Edge",
  "relatedArticles": ["fablemotion-s3-timeline", "motion-paths-onion-skin"],
  "updates": [{ "change": "S2.9 → S3", "kind": "修复", "note": "修复时间轴交互与导出", "date": "2026-07-19" }],
  "history": [
    { "date": "2026-07-19", "version": "S3 Candidate", "note": "时间轴、画布和 Graph Editor 完成合流，进入最终验收。" },
    { "date": "2026-07-17", "version": "S3 Batch 3", "note": "完善时间轴与终版 UI，修复导出链路。" },
    { "date": "2026-07-14", "version": "S3 Foundation", "note": "建立模块边界、工程配置和基础测试。" }
  ],
  "verification": [
    { "label": "源码来源", "value": "原创", "note": "项目代码与开发日志由作者维护" },
    { "label": "运行验证", "value": "进行中", "note": "Win11 Chrome / Edge 回归" },
    { "label": "发布状态", "value": "候选", "note": "不使用虚假“安全认证”徽章" }
  ],
  "issues": "真实媒体导出、复杂时间轴压力测试和移动端编辑仍需继续验证。所有状态以实际测试记录为准。",
  "ownerReview": false
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
