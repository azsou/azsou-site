/**
 * Google 标签（AdSense / GA4）需要的 CSP 来源，以及在 vercel.json 的 CSP 上开 / 关它们（P8 T8.3）。
 * 被 src/lib/ads.ts、scripts/check-csp.mjs、scripts/csp-google.mjs 与单元测试共用。
 */

/**
 * 启用 Google 标签时 CSP 需要放开的来源。说明：
 *  - AdSense 官方只「支持」基于 nonce 的严格 CSP（support.google.com/adsense/answer/16283098），
 *    本站是 Vercel 纯静态输出，没有逐请求 nonce，所以采用通配域名白名单（覆盖 AdSense 脚本、广告帧、
 *    Google CMP「隐私和消息」、广告流量质量检测、GA4），并保持 script-src 不含 'unsafe-inline' / 'unsafe-eval'。
 *    Google 新增域名时广告可能被拦，届时浏览器控制台会报 CSP 违规，把域名补到这里即可（见 docs/ADSENSE.md §4）。
 *  - 只有 GA4（没开广告）时只放开 Google 标签与统计上报域名。
 */
export const GOOGLE_CSP = {
  ga: {
    'script-src': ['https://www.googletagmanager.com'],
    'connect-src': [
      'https://www.googletagmanager.com',
      'https://*.google-analytics.com',
      'https://*.analytics.google.com',
    ],
    'img-src': ['https://www.googletagmanager.com', 'https://*.google-analytics.com'],
  },
  ads: {
    'script-src': [
      'https://pagead2.googlesyndication.com',
      'https://*.googlesyndication.com',
      'https://*.doubleclick.net',
      'https://*.googleadservices.com',
      'https://fundingchoicesmessages.google.com',
      'https://*.adtrafficquality.google',
      'https://www.google.com',
      'https://www.gstatic.com',
    ],
    'connect-src': [
      'https://*.googlesyndication.com',
      'https://*.doubleclick.net',
      'https://*.google.com',
      'https://*.adtrafficquality.google',
      'https://*.googleadservices.com',
    ],
    'img-src': [
      'https://*.googlesyndication.com',
      'https://*.doubleclick.net',
      'https://*.google.com',
      'https://*.gstatic.com',
      'https://*.googleusercontent.com',
      'https://*.adtrafficquality.google',
    ],
    'frame-src': [
      'https://*.googlesyndication.com',
      'https://*.doubleclick.net',
      'https://*.google.com',
      'https://*.adtrafficquality.google',
    ],
  },
};

/** 本站 CSP 里 Google 部分的标记：check-csp / csp-google 脚本据此判断当前 vercel.json 处于哪种状态 */
/** @param {{ ads: boolean, ga: boolean }} opts @returns {Record<string, string[]>} */
export function googleCspSources(opts) {
  /** @type {Record<string, string[]>} */
  const out = {};
  /** @param {Record<string, readonly string[]>} part */
  const add = (part) => {
    for (const [d, v] of Object.entries(part)) out[d] = [...new Set([...(out[d] ?? []), ...v])];
  };
  if (opts.ga) add(GOOGLE_CSP.ga);
  if (opts.ads) add(GOOGLE_CSP.ads);
  return out;
}

const ALL_GOOGLE = new Set(Object.values(googleCspSources({ ads: true, ga: true })).flat());
/** @param {string} v */
export const isGoogleSource = (v) => ALL_GOOGLE.has(v);

/** 在 CSP 字符串上加入 / 去掉 Google 来源（去掉时恢复到严格策略，结果与原始严格 CSP 完全一致） */
/** @param {string} csp @param {{ ads: boolean, ga: boolean }} opts @returns {string} */
export function applyGoogleCsp(csp, opts) {
  const add = googleCspSources(opts);
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...vals] = d.split(/\s+/);
      const base = vals.filter((v) => !isGoogleSource(v));
      return [name, ...base, ...(add[name] ?? [])].join(' ');
    })
    .join('; ');
}

/** 当前 CSP 里已经放开了哪些 Google 功能 */
/** @param {string} csp @returns {{ ads: boolean, ga: boolean }} */
export function googleCspState(csp) {
  /** @param {{ ads: boolean, ga: boolean }} opts */
  const has = (opts) =>
    Object.entries(googleCspSources(opts)).every(([d, vals]) => {
      const m = new RegExp(`(?:^|;)\\s*${d}\\s+([^;]*)`).exec(csp);
      const set = new Set((m?.[1] ?? '').split(/\s+/));
      return vals.every((v) => set.has(v));
    });
  return { ads: has({ ads: true, ga: false }), ga: has({ ads: false, ga: true }) };
}
