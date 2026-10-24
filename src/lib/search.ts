/**
 * 站内搜索：标题/摘要包含匹配 + 手工标注的拼音首字母（py）匹配。
 * 沿用 V63 的做法（见文章《拼音首字母搜索》）：条目量小，不引拼音库。
 */
export interface SearchItem {
  type: 'app' | 'tool' | 'game' | 'article' | 'work' | 'thread' | 'page';
  title: string;
  url: string;
  summary?: string;
  pinyin?: string;
  meta?: string;
}

export const TYPE_LABEL: Record<SearchItem['type'], string> = {
  app: '应用',
  tool: 'AI 工具',
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
