---
{
  "title": "生成式 SVG 素材：17 个母题的确定性视觉系统",
  "category": "开发实践",
  "badge": "实测",
  "author": "Randy Hopkins",
  "date": "2026-07-20",
  "lastChecked": "2026-07-20",
  "readingMinutes": 9,
  "toc": [
    "为什么自己画",
    "母题 × 调色板 × 种子",
    "确定性的价值",
    "它画不了什么"
  ],
  "tags": [
    "dev-practice",
    "tested"
  ],
  "forumThread": "t-svg-assets",
  "ogImage": "/og/generative-svg-assets.png",
  "art": null,
  "pinyin": "scsssc17gmtdqdxsjxt",
  "order": 6
}
---

<p>站内 40 个视觉槽位——首页大图、游戏封面、作品图、论坛分类图——全部来自一个 Node 脚本：17 个母题函数，按调色板与种子组合出场景，输出 base64 SVG。</p><div class="callout"><b>结论：</b>生成式素材换来的不是「好看」，是三件工程品质：零版权风险、逐字节可复现、主题风格强一致。</div><h2 id="a-sec-1">为什么自己画</h2><p>占位图服务有版权与网络依赖；AI 生图不可复现且风格漂移。自绘 SVG 把素材纳入构建：改一个种子，diff 里看得见每一字节变化。</p><h2 id="a-sec-2">母题 × 调色板 × 种子</h2><p>母题是场景函数：时间轴、体素地牢、节点图、粒子束……各自接受调色板与确定性随机种子。40 个槽位就是 40 组参数，slot 名进 data 映射，页面按 data-asset-slot 注入。</p><h2 id="a-sec-3">确定性的价值</h2><p>同一输入永远同一输出，素材参与整站的逐字节回归——几何矩阵里连封面都在被验收。伪随机源是自写的 mulberry 变体，种子写在槽位表里。</p><h2 id="a-sec-4">它画不了什么</h2><p>实机截图。所以每个槽位保留 data-asset-slot 标记，未来逐张替换真图不动结构；素材说明面板也如实写着这一点——生成艺术是诚实的占位，不是伪装的实拍。</p>
