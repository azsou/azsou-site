---
{
  "title": "接入 AdSense 之前：Consent Mode v2、认证 CMP 与 ads.txt 准备清单",
  "category": "开发实践",
  "badge": "原创",
  "author": "Randy Hopkins",
  "date": "2026-10-25",
  "lastChecked": "2026-10-25",
  "readingMinutes": 6,
  "toc": [
    "认证 CMP：欧洲访客的硬性要求",
    "Consent Mode v2：顺序比参数更重要",
    "只开统计、没开广告时怎么办",
    "ads.txt 与广告位的细节",
    "CSP、政策页与申请前检查"
  ],
  "tags": [
    "dev-practice",
    "original"
  ],
  "forumThread": null,
  "ogImage": "/og/consent-mode-adsense-prep.png",
  "art": null,
  "pinyin": "jrzqrzyzbqd",
  "order": 14,
  "description": "个人站点申请 AdSense 前要先做好的隐私准备：Google 认证 CMP、Consent Mode v2 的地区默认值与加载顺序、ads.txt、广告位规则和政策页，附官方依据。"
}
---

<p>个人站点想靠广告覆盖服务器和域名的费用，Google AdSense 几乎是第一个选择。但在提交申请之前，有几件和「隐私」有关的事必须先做好：同意管理平台（CMP）、Google 同意模式（Consent Mode v2）、ads.txt，以及隐私政策和 Cookie 政策。这些事情做晚了，轻则欧洲访客看不到广告，重则审核不通过。这篇是 azsou.com 在接入前整理的清单，每一条都附上依据，方便你对照自己的站点。</p><div class="callout"><b>结论：</b>先把 Consent Mode v2 的默认值放在一切 Google 标签之前（欧洲经济区、英国、瑞士四项全部拒绝），同意弹窗交给 AdSense 自带的「隐私和消息」（Google 认证 CMP），ads.txt 和政策页在申请前就上线；广告代码默认关闭，用环境变量开启，关着的时候站点不受任何影响。</div><h2 id="a-sec-1">认证 CMP：欧洲访客的硬性要求</h2><p>根据 AdSense 帮助中心的说明，自 2024 年 1 月 16 日起，向欧洲经济区（EEA）和英国的用户投放个性化广告，必须使用经 Google 认证、并接入 IAB 透明度与同意框架（TCF）的同意管理平台；瑞士从 2024 年 7 月 31 日起适用同样的要求。没有认证 CMP 的流量，最多只能获得非个性化广告或「受限广告」，收入会明显下降。</p><p>对个人站点来说，最省事的选择是 AdSense 后台「隐私和消息」里的欧洲法规消息：它本身就在 Google 的认证 CMP 列表里，不需要额外接第三方 SDK，弹窗由 AdSense 的广告代码负责加载，只对需要的地区显示。代价是可定制的程度有限，但对一个以内容为主的站点足够。本站的决定就是依赖它，而不是自己写一个同意弹窗——自己写的弹窗不在认证列表里，等于白做。</p><h2 id="a-sec-2">Consent Mode v2：顺序比参数更重要</h2><p>同意模式是 Google 标签读取「访客是否同意」的统一接口。2023 年 11 月的更新在原有的 <code>ad_storage</code>、<code>analytics_storage</code> 之外新增了两个参数：<code>ad_user_data</code>（是否允许把与广告相关的用户数据发送给 Google）和 <code>ad_personalization</code>（是否允许个性化广告）。这就是常说的 v2。</p><p>实现时最容易出错的是顺序。Google 的开发者文档反复强调：<code>gtag('consent', 'default', …)</code> 必须在任何发送数据的命令之前执行，顺序错了默认值就不起作用。本站的做法是把默认值和加载器写在同一个同源脚本里：先建立 dataLayer 和 gtag 函数，再设默认值，然后才去加载 AdSense 或 GA4 的脚本，从结构上保证顺序不会被打乱。</p><p>默认值按地区设置。同意模式支持在 default 命令里带 <code>region</code> 参数（ISO 3166-2 代码），带地区的命令优先于不带地区的命令。本站对欧盟 27 国、冰岛、列支敦士登、挪威、英国和瑞士，把四个参数全部设为 denied，并加上 <code>wait_for_update: 500</code>，给 CMP 半秒钟时间读取访客已有的选择；其他地区默认 granted，访客可以在 <a href="/cookies/#choices">Cookie 设置</a>里随时关闭。另外设置了 <code>ads_data_redaction</code>：在广告存储被拒绝时，进一步隐去广告点击标识。</p><h2 id="a-sec-3">只开统计、没开广告时怎么办</h2><p>一个常被忽略的情况：如果暂时只接入 Google Analytics 4，没有 AdSense，也就没有「隐私和消息」那个认证弹窗，欧洲访客的统计存储会一直停在 denied。这时有两种选择：接受欧洲流量的统计缺失，或者自己提供一个最简单的同意条。</p><p>本站的处理是后者，但只在必要时出现：只有启用了 GA4、没有启用 AdSense、访客还没做过选择、并且浏览器时区属于欧洲时，才在页面底部显示一条固定定位的同意条（不推动页面布局），同意前不加载统计脚本。时区判断只是近似，所以默认方向是保守的：判断不了就当作需要同意。一旦启用 AdSense，这条同意条自动让位给 Google 的认证弹窗。</p><h2 id="a-sec-4">ads.txt 与广告位的细节</h2><p>ads.txt 是 IAB 的「授权数字卖方」规范，放在站点根目录，声明谁有权出售你网站的广告位。AdSense 不强制要求，但强烈建议，缺失时后台会一直提示。它的内容只有一行：<code>google.com, pub-你的发布商ID, DIRECT, f08c47fec0942fa0</code>，其中发布商 ID 就是广告代码里 <code>ca-pub-</code> 去掉 <code>ca-</code> 的部分，最后一段是 Google 固定的认证机构 ID。</p><p>本站的 ads.txt 由构建脚本根据环境变量生成：变量没设时这个文件根本不存在（返回 404），设了才输出那一行，避免把一个空的或错的 ads.txt 放到线上。</p><p>广告位本身也有几条自我约束：每个广告位预留固定高度，广告没填充、访客拒绝同意或被拦截时高度不变，页面不会跳动；标注「广告」字样；与任何下载、跳转按钮保持至少 150 像素的距离，这一点写成了端到端测试；后台、登录注册、表单、订阅、404 与法律说明页不放广告；正文不足约 1500 字的短文也不放。这些规则写在<a href="/ad-disclosure/">广告与联盟披露</a>页，访客可以对照监督。</p><h2 id="a-sec-5">CSP、政策页与申请前检查</h2><p>如果站点启用了内容安全策略，要注意 AdSense 官方只支持基于 nonce 的严格 CSP，白名单方式可能随着 Google 新增域名而失效。纯静态站没有逐请求的 nonce，本站采用默认关闭、开启时才加入的 Google 域名白名单，并在文档里写明出问题时如何排查，详见<a href="/articles/static-site-strict-csp/">静态站点的严格 CSP</a>。</p><p>政策页方面，隐私政策需要说明 Google 作为第三方供应商会使用 Cookie 投放广告，并给出停用个性化广告的入口（Google 广告设置、aboutads.info）；Cookie 政策列出每一项存储的名称、用途和有效期；另外准备好关于页和联系页，让审核者能确认站点由谁运营、如何联系。本站的这几页是：<a href="/privacy/">隐私政策</a>、<a href="/cookies/">Cookie 政策</a>、<a href="/about/">关于</a>、<a href="/contact/">联系</a>。</p><p>最后是内容本身。AdSense 政策要求网站提供独特、有价值的内容，「价值不高的内容」是常见的拒审原因。所以真正的准备工作不在代码里：站点正式上线、有足够数量的原创长文、没有空页面和占位内容之后，再提交申请。代码可以先写好、默认关着——这正是本站现在的状态。</p>
