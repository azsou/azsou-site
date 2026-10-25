/**
 * 站内搜索引擎（T7.1）：Pagefind（构建期全文索引，中文分词）+ 站内 JSON 索引（标题 / 拼音首字母）。
 *  - 两者都只在第一次搜索时下载；Pagefind 的 WASM 在它自己的 Web Worker（/pagefind/pagefind-worker.js）里运行，
 *    只有那个 Worker 的响应 CSP 带 'wasm-unsafe-eval'（vercel.json），页面本身的 CSP 不放开。
 *  - Pagefind 不可用（开发模式没有索引、网络错误）时退回站内 JSON 索引，搜索照常可用。
 */
import { excerptParts, isSearchType, mergeHits, type SearchHit, type SearchItem } from '@/lib/search';

interface PagefindResult {
  id: string;
  data(): Promise<{ url: string; excerpt: string; meta: Record<string, string> }>;
}
interface Pagefind {
  options(o: Record<string, unknown>): Promise<void>;
  init(): Promise<void>;
  search(q: string): Promise<{ results: PagefindResult[] } | null>;
}

const PAGEFIND = '/pagefind/pagefind.js';
let pf: Promise<Pagefind | null> | null = null;
let index: Promise<SearchItem[]> | null = null;

function loadPagefind(): Promise<Pagefind | null> {
  pf ??= import(/* @vite-ignore */ PAGEFIND)
    .then(async (m: Pagefind) => {
      await m.options({ excerptLength: 28 });
      await m.init();
      return m;
    })
    .catch(() => null);
  return pf;
}

function loadIndex(): Promise<SearchItem[]> {
  index ??= fetch('/search-index.json')
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<SearchItem[]>;
    })
    .catch((e) => {
      index = null;
      throw e;
    });
  return index;
}

/** 预热（打开面板时就开始下载，不等第一次输入） */
export function warmUp() {
  void loadPagefind();
  void loadIndex().catch(() => {});
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Pagefind 是否参与了这次搜索（false = 只用了站内索引） */
  fullText: boolean;
}

export async function searchSite(query: string, limit = 30): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) return { hits: [], fullText: false };
  const [items, engine] = await Promise.all([loadIndex().catch(() => [] as SearchItem[]), loadPagefind()]);
  let pfHits: SearchHit[] = [];
  if (engine) {
    try {
      const res = await engine.search(q);
      const top = (res?.results ?? []).slice(0, limit);
      pfHits = (await Promise.all(top.map((r) => r.data()))).map((d) => ({
        type: isSearchType(d.meta.type) ? d.meta.type : 'page',
        title: d.meta.title || d.url,
        url: d.url,
        sub: '',
        excerpt: excerptParts(d.excerpt),
      }));
    } catch {
      pfHits = [];
    }
  }
  if (!engine && !items.length) throw new Error('search unavailable');
  return { hits: mergeHits(items, q, pfHits, limit), fullText: !!engine };
}
