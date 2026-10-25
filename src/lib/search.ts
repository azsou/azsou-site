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

export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 返回 0 表示不命中；分数越高越靠前 */
export function score(item: SearchItem, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const title = normalize(item.title);
  const py = normalize(item.pinyin || '');
  const rest = normalize(`${item.summary || ''} ${item.meta || ''}`);
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  const compact = q.replace(/\s/g, '');
  if (py && /^[a-z0-9]+$/.test(compact)) {
    if (py === compact) return 70;
    if (py.startsWith(compact)) return 50;
    if (py.includes(compact)) return 30;
  }
  if (rest.includes(q)) return 20;
  return 0;
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
    else if (piece) out.push({ text: decode(piece.replace(/<[^>]*>/g, '')), mark });
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
