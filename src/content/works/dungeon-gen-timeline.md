---
{
  "title": "地牢生成时间序列",
  "kind": "游戏画面",
  "art": "work-13",
  "hue": "teal",
  "date": "2026-05",
  "status": "测试归档",
  "order": 9,
  "pinyin": "dlscsjxl",
  "facts": [
    {
      "label": "管线",
      "value": "四阶段生成器"
    },
    {
      "label": "用途",
      "value": "生成回归基线"
    },
    {
      "label": "种子",
      "value": "d3-7741 系列"
    },
    {
      "label": "验证",
      "value": "阶段输出哈希锁定"
    }
  ],
  "related": [
    {
      "type": "game",
      "slug": "dungeon-gen-viz"
    },
    {
      "type": "work",
      "slug": "emberdeep-voxel-scene"
    }
  ]
}
---

<p>同一种子下地牢生成器四个阶段的对照：房间播撒、走廊连通、主路径标记、装饰落位。用于回归测试——任何阶段的输出变化都会在对照表里现形。</p>
