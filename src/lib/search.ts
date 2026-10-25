/**
 * 站内搜索：标题/摘要包含匹配 + 手工标注的拼音首字母（py）匹配。
 * 沿用 V63 的做法（见文章《拼音首字母搜索》）：条目量小，不引拼音库。
 */
export interface SearchItem {
  type: 'app' | 'tool' | 'video' | 'game' | 'article' | 'work' | 'thread' | 'page';
  title: string;
  url: string;
  summary?: string;
  pinyin?: string;
  meta?: string;
}

export const TYPE_LABEL: Record<SearchItem['type'], string> = {
  app: '应用',
  tool: 'AI 工具',
  video: '视频',
  game: '游戏',
  article: '文章',
  work: '作品',
  thread: '论坛',
  page: '页面',
};

/** 英文版（/en/，T7.6）的类型徽章 */
export const TYPE_LABEL_EN: Record<SearchItem['type'], string> = {
  app: 'App',
  tool: 'AI tool',
  video: 'Video',
  game: 'Game',
  article: 'Article',
  work: 'Work',
  thread: 'Forum',
  page: 'Page',
};

export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 实体类型权重（T9.13）：同分时应用 / AI 工具在前，其次游戏 / 视频 / 文章，页面最后 */
const TYPE_WEIGHT: Record<SearchItem['type'], number> = {
  app: 3,
  tool: 3,
  game: 2,
  video: 1,
  article: 1,
  work: 1,
  thread: 0,
  page: 0,
};

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * 返回 0 表示不命中；分数越高越靠前（DESIGN-SYSTEM / PLAN T9.13）：
 * 标题完全匹配 100 > 标题前缀 / 标题里有整词 80 > 拼音全拼首字母 70 > 标题里有词以它开头 65 > 标题包含 60
 * > 拼音前缀 50 > 拼音包含 30 > 摘要包含 20；再加实体类型权重（0–3）。
 */
export function score(item: SearchItem, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const title = normalize(item.title);
  const py = normalize(item.pinyin || '');
  const rest = normalize(`${item.summary || ''} ${item.meta || ''}`);
  const w = TYPE_WEIGHT[item.type] ?? 0;
  if (title === q) return 100 + w;
  if (title.startsWith(q)) return 80 + w;
  const tw = words(title);
  if (tw.includes(q)) return 80 + w;
  const compact = q.replace(/\s/g, '');
  if (py && /^[a-z0-9]+$/.test(compact) && py === compact) return 70 + w;
  if (tw.some((x) => x.startsWith(q))) return 65 + w;
  if (title.includes(q)) return 60 + w;
  if (py && /^[a-z0-9]+$/.test(compact)) {
    if (py.startsWith(compact)) return 50 + w;
    if (py.includes(compact)) return 30 + w;
  }
  if (rest.includes(q)) return 20 + w;
  return 0;
}

/** Damerau–Levenshtein（相邻换位算 1）；超过 max 提前返回 max + 1 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/**
 * 错拼建议（T9.13）：没有标题强命中时，在标题与标题里的词中找编辑距离 ≤ 2 的最接近者
 * （「cluade」→「Claude」）。只对 ≥ 4 个字符的拉丁词生效，避免短词乱猜；返回原样大小写的词。
 */
export function suggest(items: SearchItem[], query: string): string | null {
  const q = normalize(query);
  if (q.length < 4 || !/^[a-z0-9 .+-]+$/.test(q)) return null;
  if (items.some((it) => score(it, q) >= 50)) return null;
  let best: { word: string; d: number; w: number } | null = null;
  for (const it of items) {
    const cands = [it.title, ...it.title.split(/[^\p{L}\p{N}.+-]+/u)];
    for (const c of cands) {
      const n = normalize(c);
      if (n.length < 3 || n === q) continue;
      const max = q.length >= 6 ? 2 : 1;
      const dist = editDistance(q, n, max);
      if (dist > max) continue;
      const w = TYPE_WEIGHT[it.type] ?? 0;
      if (!best || dist < best.d || (dist === best.d && w > best.w)) best = { word: c.trim(), d: dist, w };
    }
  }
  return best?.word ?? null;
}

/** 摘要清理：Pagefind 把相邻块用「. 」连起来，中文后面不该出现英文句点（T9.13） */
export function tidyExcerpt(text: string): string {
  return text.replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\.\s+/g, '$1 ').replace(/\s{2,}/g, ' ');
}

export function search(items: SearchItem[], query: string, limit = 50): SearchItem[] {
  return items
    .map((item, i) => ({ item, s: score(item, query), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

// ------------------------------------------------------------ T7.1 Pagefind ----

/** 一条展示用的搜索结果（站内 JSON 索引与 Pagefind 合并后） */
export interface SearchHit {
  type: SearchItem['type'];
  title: string;
  url: string;
  /** 副标题：分类 / 日期等（站内索引的 meta，或 Pagefind 的摘要） */
  sub: string;
  /** Pagefind 摘要（已转成片段，mark=true 为命中词） */
  excerpt?: ExcerptPart[];
}

export interface ExcerptPart {
  text: string;
  mark: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Pagefind 的摘要是「转义后的纯文本 + <mark>」。这里拆成片段交给 textContent 渲染，
 * 不把任何 HTML 直接塞进页面（即使索引里混进了标签也只会显示成文字）。
 */
export function excerptParts(html: string): ExcerptPart[] {
  const out: ExcerptPart[] = [];
  let mark = false;
  for (const piece of html.split(/(<mark>|<\/mark>)/i)) {
    if (/^<mark>$/i.test(piece)) mark = true;
    else if (/^<\/mark>$/i.test(piece)) mark = false;
    else if (piece) out.push({ text: tidyExcerpt(decode(piece.replace(/<[^>]*>/g, ''))), mark });
  }
  return out;
}

export const isSearchType = (t: unknown): t is SearchItem['type'] =>
  typeof t === 'string' && Object.prototype.hasOwnProperty.call(TYPE_LABEL, t);

/** 站内路径（Pagefind 给的 url 统一成以 / 开头、去掉 index.html） */
export const normalizeUrl = (u: string) => {
  try {
    const p = new URL(u, 'https://azsou.com').pathname;
    return p.replace(/index\.html$/, '');
  } catch {
    return u;
  }
};

/**
 * 合并：站内索引里标题 / 拼音的强命中（≥ 50 分）在最前 → Pagefind 全文结果 → 其余站内命中（摘要包含）。
 * 同一 URL 只出现一次（保留排在前面的那条，并补上 Pagefind 摘要）。
 */
export function mergeHits(
  items: SearchItem[],
  query: string,
  pagefind: SearchHit[],
  limit = 30,
): SearchHit[] {
  const scored = items
    .map((item, i) => ({ item, s: score(item, query), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  const toHit = (it: SearchItem): SearchHit => ({
    type: it.type,
    title: it.title,
    url: it.url,
    sub: it.meta || it.summary || '',
  });
  const out: SearchHit[] = [];
  const seen = new Map<string, SearchHit>();
  const push = (h: SearchHit) => {
    const key = normalizeUrl(h.url);
    const prev = seen.get(key);
    if (prev) {
      if (!prev.excerpt && h.excerpt) prev.excerpt = h.excerpt;
      return;
    }
    seen.set(key, h);
    out.push(h);
  };
  for (const x of scored) if (x.s >= 50) push(toHit(x.item));
  for (const h of pagefind) push({ ...h });
  for (const x of scored) if (x.s < 50) push(toHit(x.item));
  return out.slice(0, limit);
}
