---
{
  "title": "地牢生成可视化",
  "kind": "开发中",
  "art": "game-10",
  "hue": "green",
  "version": "0.4",
  "status": "开发中 · 可视化可用",
  "date": "2026-07-10",
  "order": 7,
  "pinyin": "dlscksh",
  "genre": "算法可视化",
  "facts": [
    {
      "label": "形态",
      "value": "算法可视化"
    },
    {
      "label": "版本",
      "value": "0.4"
    },
    {
      "label": "算法",
      "value": "图生成 + MST"
    },
    {
      "label": "状态",
      "value": "开发中"
    },
    {
      "label": "最后核对",
      "value": "2026-07-10"
    }
  ],
  "log": [
    {
      "version": "0.4",
      "date": "2026-07-10",
      "note": "逐步播放与种子输入"
    },
    {
      "version": "0.3",
      "date": "2026-06-30",
      "note": "MST 与回环补边可视化"
    }
  ],
  "issues": "导出 GIF 未做；大种子（>10⁶ 节点）会卡 UI 线程。"
}
---

<p>把 EMBERDEEP 的图生成算法逐步可视化：房间图、最小生成树、回环补边、走廊挖掘，每一步都能单步观看。既是调试工具也是教学演示。</p>
