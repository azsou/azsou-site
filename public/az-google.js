/*
 * AZ Studio · Google 标签加载器（P8）。只有构建时设置了 PUBLIC_ADSENSE_CLIENT 或 PUBLIC_GA4_ID 才会被页面引用。
 * 顺序（Consent Mode v2 要求默认值先于任何 Google 标签）：
 *   1. dataLayer / gtag 桩 → consent default：EEA + 英国 + 瑞士四项全部 denied（region 参数，等 CMP 500ms），其余地区 granted
 *   2. 读访客在 /cookies/ 页保存的选择（localStorage az-consent）→ consent update
 *   3. AdSense：本页有广告位且未被访客拒绝时加载 adsbygoogle.js；EEA / 英国 / 瑞士的同意弹窗由 AdSense「隐私和消息」（Google 认证 CMP，TCF）负责
 *   4. GA4：未被拒绝时加载 gtag.js；只开 GA4、没开 AdSense 时没有 Google CMP，欧洲时区访客先显示一条极简同意条，同意前不加载
 * 本文件是同源外链脚本（不是内联脚本），不需要 CSP 哈希；配置走 <script data-*>。用 defer 加载：解析完 DOM 再执行，才能找到广告位。
 */
(function () {
  var s = document.currentScript;
  var cfg = (s && s.dataset) || {};
  var w = window;
  var d = document;
  w.dataLayer = w.dataLayer || [];
  function gtag() {
    w.dataLayer.push(arguments);
  }
  w.gtag = w.gtag || gtag;

  // EEA（欧盟 27 国 + 冰岛、列支敦士登、挪威）+ 英国 + 瑞士
  var REGIONS = [
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
    'IS',
    'LI',
    'NO',
    'GB',
    'CH',
  ];
  var ALL = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'];
  function signals(ads, analytics) {
    return {
      ad_storage: ads,
      ad_user_data: ads,
      ad_personalization: ads,
      analytics_storage: analytics,
    };
  }
  var denied = signals('denied', 'denied');
  denied.region = REGIONS;
  denied.wait_for_update = 500;
  w.gtag('consent', 'default', denied);
  w.gtag('consent', 'default', signals('granted', 'granted'));
  w.gtag('set', 'ads_data_redaction', true);

  var KEY = 'az-consent';
  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (
        v &&
        (v.ads === 'granted' || v.ads === 'denied') &&
        (v.analytics === 'granted' || v.analytics === 'denied')
      )
        return v;
    } catch (e) {
      /* 隐私模式读不到存储：按默认值 */
    }
    return null;
  }
  var choice = read();
  if (choice) w.gtag('consent', 'update', signals(choice.ads, choice.analytics));

  function load(src, cross) {
    var el = d.createElement('script');
    el.async = true;
    el.src = src;
    if (cross) el.crossOrigin = 'anonymous';
    d.head.appendChild(el);
  }

  // ---- AdSense
  // 只在本页真的有广告位时加载（不开「自动广告」：广告只出现在 AdSlot 预留好的位置）
  var client = /^ca-pub-\d{16}$/.test(cfg.client || '') ? cfg.client : '';
  var slots = d.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])');
  if (client && slots.length && !(choice && choice.ads === 'denied')) {
    load('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + client, true);
    w.adsbygoogle = w.adsbygoogle || [];
    for (var i = 0; i < slots.length; i++) w.adsbygoogle.push({});
  }

  // ---- GA4
  var ga = /^G-[A-Z0-9]{4,12}$/.test(cfg.ga || '') ? cfg.ga : '';
  var europe = false;
  try {
    europe = /^(Europe|Atlantic\/(Reykjavik|Canary|Madeira|Faroe))\//.test(
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    );
  } catch (e) {
    europe = false;
  }
  function startGa() {
    if (!ga || w.__azGa) return;
    w.__azGa = true;
    load('https://www.googletagmanager.com/gtag/js?id=' + ga, false);
    w.gtag('js', new Date());
    w.gtag('config', ga);
  }
  if (ga && !(choice && choice.analytics === 'denied')) {
    if (client || choice || !europe) startGa();
    else banner();
  }

  function save(ads, analytics) {
    var v = { ads: ads, analytics: analytics, ts: new Date().toISOString().slice(0, 10) };
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch (e) {
      /* 存不下就只对本页生效 */
    }
    w.gtag('consent', 'update', signals(ads, analytics));
    if (analytics === 'granted') startGa();
    choice = v;
  }

  // 只开 GA4（没有 Google CMP）时的极简同意条：固定定位，不推动布局
  function banner() {
    if (d.getElementById('az-consent-bar')) return;
    var en = d.documentElement.lang === 'en';
    var bar = d.createElement('div');
    bar.id = 'az-consent-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', en ? 'Cookie consent' : 'Cookie 同意');
    bar.className = 'consent-bar';
    var p = d.createElement('p');
    p.textContent = en
      ? 'We use Google Analytics cookies to understand which pages help readers. Allow analytics cookies?'
      : '本站用 Google Analytics 统计哪些页面对读者有用。是否允许统计 Cookie？';
    var more = d.createElement('a');
    more.href = en ? '/en/cookies/' : '/cookies/';
    more.textContent = en ? 'Details' : '详情';
    p.appendChild(d.createTextNode(' '));
    p.appendChild(more);
    var yes = d.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn--primary';
    yes.textContent = en ? 'Allow' : '允许';
    var no = d.createElement('button');
    no.type = 'button';
    no.className = 'btn';
    no.textContent = en ? 'Decline' : '拒绝';
    yes.addEventListener('click', function () {
      save('denied', 'granted');
      bar.remove();
    });
    no.addEventListener('click', function () {
      save('denied', 'denied');
      bar.remove();
    });
    bar.appendChild(p);
    bar.appendChild(no);
    bar.appendChild(yes);
    d.body.appendChild(bar);
  }

  // /cookies/ 页的「隐私选择」与页脚入口调用这个接口
  w.azConsent = {
    signals: ALL,
    get: read,
    set: save,
    enabled: { ads: !!client, analytics: !!ga },
    // AdSense CMP 生效时，优先打开 Google 的撤回 / 修改同意弹窗
    openCmp: function () {
      if (w.googlefc && w.googlefc.callbackQueue && w.googlefc.showRevocationMessage) {
        w.googlefc.callbackQueue.push(w.googlefc.showRevocationMessage);
        return true;
      }
      return false;
    },
  };
  d.dispatchEvent(new CustomEvent('az-consent-ready'));
})();
