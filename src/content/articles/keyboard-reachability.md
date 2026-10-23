---
{
  "title": "两键导航与帮助面板：个人站的键盘可达性",
  "category": "开发实践",
  "badge": "原创",
  "author": "Randy Hopkins",
  "date": "2026-07-23",
  "lastChecked": "2026-07-23",
  "readingMinutes": 7,
  "toc": [
    "为什么是 g 前缀",
    "实现要点",
    "别打扰输入框",
    "帮助面板"
  ],
  "tags": [
    "dev-practice",
    "original"
  ],
  "forumThread": "t-v63-changelog",
  "ogImage": "/og/keyboard-reachability.png",
  "art": null,
  "pinyin": "ljdhybzmbgrzdjpkdx",
  "order": 3
}
---

<p>V63 给站点加了 Gmail 式两键导航：g 然后 h/a/g/t/w/f/n，八个视图一秒直达；? 呼出快捷键帮助。这篇记录实现里容易踩的四个坑。</p><div class="callout"><b>结论：</b>两键序列的全部复杂度都在「什么时候不触发」：输入框里、修饰键按着、序列超时，三个否定条件比肯定逻辑更重要。</div><h2 id="a-sec-1">为什么是 g 前缀</h2><p>单键直达会和浏览器/输入法抢按键；g 前缀把冲突面收敛到一个键，且 Gmail/GitHub 用户零学习成本。900ms 序列窗口是实测出来的：短了赶不上，长了误触。</p><h2 id="a-sec-2">实现要点</h2><p>状态只有一个时间戳：pendingG。keydown 里先判 Escape（关帮助），再判「正在打字/带修饰键」直接放行，再判 ?，最后走序列逻辑。整个模块 60 行。</p><h2 id="a-sec-3">别打扰输入框</h2><p>target 是 INPUT/TEXTAREA/SELECT/contentEditable 时一律放行——搜索框里输 gf 是在搜「gf」，不是要去论坛。这条判断放在最前，出错最伤信任。</p><h2 id="a-sec-4">帮助面板</h2><p>? 面板列出全部快捷键：固定右下、Esc 或点关闭收起、role=dialog。快捷键不写进帮助等于不存在——可发现性是可达性的一半。</p>
