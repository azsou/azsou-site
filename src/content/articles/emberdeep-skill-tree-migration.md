---
{
  "title": "职业技能树与旧存档迁移",
  "category": "AI 游戏",
  "badge": "原创技术文章",
  "author": "Randy Hopkins",
  "date": "2026-07-17",
  "lastChecked": "2026-07-19",
  "readingMinutes": 13,
  "toc": [
    "数据驱动的职业系统",
    "节点、前置与互斥",
    "旧存档怎么迁",
    "平衡性验收"
  ],
  "tags": [
    "ai-games"
  ],
  "forumThread": "t-feedback",
  "ogImage": "/og/emberdeep-skill-tree-migration.png",
  "art": "article-game",
  "pinyin": "zyjnsyjcdqy",
  "order": 11
}
---

<p>EMBERDEEP 0.8 把四个职业的技能全部搬进一份数据表：节点、前置、互斥、成长曲线都是配置而不是代码。这不是为了优雅，是为了让 0.7 的旧存档能安全走进新系统。</p><div class="callout"><b>结论：</b>先给旧存档做"翻译层"，再谈新系统。直接改存档结构的方案在第一晚就丢了两个测试玩家的进度，全部回滚。</div><h2 id="a-sec-1">数据驱动的职业系统</h2><p>每个技能节点是一条记录：<code>id、tier、requires[]、excludes[]、cost</code>。运行时只做两件事——校验图的连通性，和把节点效果编译成修正器列表。改平衡从改代码变成改表。</p><h2 id="a-sec-2">节点、前置与互斥</h2><p>前置是有向边，互斥是无向边。加载时先跑一遍拓扑检查：环、悬空前置、互斥对里同时可达的死配置，全部在启动即报错，而不是等玩家点出来。</p><pre><code>{ "id": "ember-burst", "tier": 2,
  "requires": ["ember-touch"],
  "excludes": ["frost-line"],
  "cost": 2 }</code></pre><h2 id="a-sec-3">旧存档怎么迁</h2><p>0.7 存档只记"已学技能名"。迁移层把名字映射到新节点 id，映射不到的技能折算成未分配点数并在进入游戏时提示。迁移是纯函数，同一份旧存档永远得到同一结果，回归测试锁死这一点。</p><h2 id="a-sec-4">平衡性验收</h2><ul><li>四职业 1-10 级模拟通关时间差 &lt; 18%</li><li>任意合法加点路径不存在无法通关的死档</li><li>0.7 全部 37 份测试存档迁移后可正常进入并继续游戏</li><li>迁移报告在设置页可回看，不弹打断式对话框</li></ul>
