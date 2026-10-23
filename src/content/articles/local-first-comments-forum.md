---
{
  "title": "本地优先的评论与论坛：localStorage 数据模型设计",
  "category": "开发实践",
  "badge": "原创",
  "author": "Randy Hopkins",
  "date": "2026-07-24",
  "lastChecked": "2026-07-24",
  "readingMinutes": 10,
  "toc": [
    "为什么本地优先",
    "两个存储的形状",
    "种子与覆盖层",
    "冻结为 API 契约",
    "后记（V68）"
  ],
  "tags": [
    "dev-practice",
    "original"
  ],
  "forumThread": "t-feedback",
  "ogImage": "/og/local-first-comments-forum.png",
  "art": null,
  "pinyin": "bdyxdplyltsjmxsj",
  "order": 2
}
---

<p>V62/V63 给站点加评论和论坛时还没有后端。当时的做法是本地优先：交互全量实现，数据落在访客自己的 localStorage，界面处处如实标注。</p><div class="callout"><b>结论：</b>本地优先不是妥协，是把「数据模型设计」提前到后端存在之前——schema 对了，接后端只是换存储。</div><h2 id="a-sec-1">为什么本地优先</h2><p>假后端（伪造别人的评论）违反站点的编辑原则；没有交互又验证不了设计。本地优先是第三条路：真交互、真数据、真隔离，只是数据的主人恰好是访客本人。</p><h2 id="a-sec-2">两个存储的形状</h2><p>az-comments 是 {"页面键": [评论]}，页面键形如 article:slug / work:slug / game:slug，天然按页隔离。az-forum 是 {threads:[], replies:{帖子id:[]}}——主题与回复分表，回复挂在任意帖（含种子帖）之下。</p><h2 id="a-sec-3">种子与覆盖层</h2><p>种子内容全部站长署名、带「站长」徽章，解释规则或开启话题；访客内容叠加其上，可删除、标「我」。两层永不混淆：种子在 data 里随版本发布，覆盖层只在访客本机。</p><h2 id="a-sec-4">冻结为 API 契约</h2><p>下一步把这两个 schema 原样冻结成 REST 契约：POST /api/comments 的请求体就是本地条目的形状。前端代码届时只换存储适配层，交互零改动——这就是本地优先阶段真正买到的东西。</p><h2 id="a-sec-5">后记（V68）</h2><p>这套 schema 后来原样冻结成了 API 契约，并在 V68 接入 Supabase 成为真实后端——评论与论坛的交互代码零改动，只换了存储适配层。本地优先阶段承诺的那笔收益，如数兑现。</p>
