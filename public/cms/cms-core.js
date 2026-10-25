/**
 * CMS 体验（T9.17）的纯逻辑：不依赖 Decap / React，单元测试直接导入（tests/unit/cms-ext.test.ts）。
 * zhLength 与 src/lib/zh-length.ts 同一算法（汉字 / 全角 = 1，拉丁字母 / 数字 / 半角 = 0.5），
 * 上下限与 src/content.config.ts 的 zh(max, min) 一致——超出时 CMS 拦住保存，构建也会失败。
 */
export function zhLength(s) {
  let n = 0;
  for (const c of String(s ?? '')) n += c.charCodeAt(0) < 0x100 ? 0.5 : 1;
  return n;
}

/** 计数：zh = 中文排版字数（默认），chars = 字符数（schema 用 z.string().max() 的字段） */
export function measure(value, mode = 'zh') {
  const s = String(value ?? '');
  return mode === 'chars' ? [...s].length : zhLength(s);
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * 校验字数：返回 { n, ok, state, message }。
 * state：empty（空且非必填）| short | ok | near（≥ 90% 上限）| over。message 用于保存拦截与读屏。
 */
/** @param {unknown} value @param {{ min?: number, max?: number, mode?: string, required?: boolean }} [opts] */
export function checkLength(value, opts = {}) {
  const { min, max, mode = 'zh', required = true } = opts;
  const n = measure(value, mode);
  const unit = mode === 'chars' ? '个字符' : '字';
  if (!n && !required) return { n, ok: true, state: 'empty', message: '' };
  if (max != null && n > max)
    return { n, ok: false, state: 'over', message: `超出 ${fmt(n - max)} ${unit}（上限 ${max}）` };
  if (min != null && n < min)
    return { n, ok: false, state: 'short', message: `还差 ${fmt(min - n)} ${unit}（至少 ${min}）` };
  return { n, ok: true, state: max != null && n >= max * 0.9 ? 'near' : 'ok', message: '' };
}

/** 计数器文字：「12 / 16」或「12 / 6–16」 */
/** @param {number} n @param {{ min?: number, max?: number }} [lim] */
export function counterText(n, lim = {}) {
  const { min, max } = lim;
  const range = min != null ? `${min}–${max}` : `${max}`;
  return `${fmt(n)} / ${range}`;
}

/** Decap 的 slug 规则（config.yml：encoding ascii + clean_accents）的近似，用于预览地址 */
export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const SECTION = { apps: 'apps', tools: 'ai', articles: 'articles' };
const OG = { apps: 'app', tools: 'tool', articles: 'article' };

/** 线上地址与分享卡数据（slug 为空时用标题推算，并标注「保存后确定」） */
export function pagePreview(collection, data, slug) {
  const s = slug || slugify(data?.title) || 'new-entry';
  const section = SECTION[collection] ?? collection;
  const desc = String((collection === 'articles' ? data?.description : data?.summary) ?? '').trim();
  return {
    slug: s,
    tentative: !slug,
    url: `https://azsou.com/${section}/${s}/`,
    ogTitle: `${String(data?.title ?? '').trim() || '（未填标题）'} · AZ Studio`,
    ogDescription: desc.length > 110 ? `${desc.slice(0, 109)}…` : desc,
    ogImage:
      collection === 'articles' && data?.ogImage ? data.ogImage : `/og/${OG[collection] ?? 's'}/${s}.png`,
  };
}

/** 图片字段指引（DESIGN-SYSTEM §15 / §19）：比例、尺寸、格式 */
export const IMAGE_GUIDE = {
  icon: '方形 1:1，至少 512×512 PNG / SVG，主体留 10% 安全边距；上传后由 npm run icons 规范化为 32–224 多档 AVIF / WebP',
  screenshot:
    '桌面 16:10（建议 2560×1600）、手机 9:19.5（1170×2532）、平板 4:3；PNG / WebP，单张 ≤ 1.5 MB；概念图要勾「概念图」',
  og: '分享图 1200×630（1.91:1）PNG，标题文字留在中间 1000×500 内；不填用栏目默认图',
};
