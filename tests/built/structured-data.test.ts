/**
 * T6.10 结构化数据：解析构建产物（dist/client/**.html）里的 JSON-LD，按页面类型校验必填字段
 * （schema.org 类型 + Google 富结果文档的必填 / 推荐字段），并保证评分、计数只来自真实数据。
 * 需要先 `npm run build`；CI 在 build 之后跑 `npm run test:ld`。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist/client';
const SITE = 'https://azsou.com';
type Node = Record<string, unknown> & { '@type'?: string; '@id'?: string };

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  throw new Error('没有构建产物：先运行 npm run build');
}

function htmlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    // /cms/ 是 Decap CMS 的单页后台（T7.7，noindex），不是站点页面
    if (e.isDirectory() && path.relative(ROOT, p) === 'cms') return [];
    return e.isDirectory() ? htmlFiles(p) : e.name.endsWith('.html') ? [p] : [];
  });
}
const routeOf = (f: string) =>
  '/' +
  path
    .relative(ROOT, f)
    .split(path.sep)
    .join('/')
    .replace(/(^|\/)index\.html$/, '$1');

interface Page {
  route: string;
  html: string;
  nodes: Node[];
  canonical: string | null;
  noindex: boolean;
}
const pages: Page[] = htmlFiles(ROOT).map((f) => {
  const html = fs.readFileSync(f, 'utf8');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const nodes = blocks.flatMap((m) => {
    const d = JSON.parse(m[1]) as Node & { '@graph'?: Node[] };
    expect(d['@context']).toBe('https://schema.org');
    return d['@graph'] ?? [d];
  });
  return {
    route: routeOf(f),
    html,
    nodes,
    canonical: /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? null,
    noindex: /<meta name="robots" content="noindex/.test(html),
  };
});
const byRoute = new Map(pages.map((p) => [p.route, p]));
const page = (r: string) => {
  const p = byRoute.get(r);
  if (!p) throw new Error(`没有页面 ${r}`);
  return p;
};
const ofType = (p: Page, t: string) => p.nodes.filter((n) => n['@type'] === t);
const one = (p: Page, t: string) => {
  const xs = ofType(p, t);
  expect(xs, `${p.route} 应有且只有一个 ${t}`).toHaveLength(1);
  return xs[0];
};

/** 内容集合的 frontmatter（JSON）：用来核对结构化数据只写了真实存在的字段 */
function content<T = Record<string, unknown>>(dir: string): Map<string, T> {
  const base = path.join('src/content', dir);
  return new Map(
    fs
      .readdirSync(base)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(base, f), 'utf8');
        const json = raw.split(/^---$/m)[1];
        return [f.replace(/\.md$/, ''), JSON.parse(json) as T];
      }),
  );
}

const isAbs = (u: unknown) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
const isIsoDate = (s: unknown) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(s);
const text = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
const routes = (re: RegExp) => pages.filter((p) => re.test(p.route));

const ID_ROUTES = (re: RegExp, expected: number) => {
  const rs = routes(re);
  expect(rs.length, String(re)).toBeGreaterThanOrEqual(expected);
  return rs;
};

describe('every page', () => {
  it('has WebSite (with SearchAction), Organization (with logo) and Person', () => {
    for (const p of pages) {
      const w = one(p, 'WebSite');
      expect(w.url).toBe(`${SITE}/`);
      const act = w.potentialAction as {
        '@type': string;
        target: { urlTemplate: string };
        'query-input': string;
      };
      expect(act['@type']).toBe('SearchAction');
      expect(act.target.urlTemplate).toBe(`${SITE}/search/?q={search_term_string}`);
      expect(act['query-input']).toBe('required name=search_term_string');
      const o = one(p, 'Organization');
      expect(text(o.name)).toBe(true);
      expect(isAbs((o.logo as { url: string }).url)).toBe(true);
      const person = one(p, 'Person');
      expect(text(person.name)).toBe(true);
    }
  });

  it('every @id reference resolves inside the same graph', () => {
    for (const p of pages) {
      const ids = new Set(p.nodes.map((n) => n['@id']).filter(Boolean));
      const refs: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          const o = v as Node;
          if (o['@id'] && Object.keys(o).length === 1) refs.push(o['@id']);
          Object.values(o).forEach(walk);
        }
      };
      p.nodes.forEach(walk);
      for (const r of refs) expect(ids.has(r), `${p.route}: 未解析的 @id ${r}`).toBe(true);
    }
  });

  it('never carries ratings, review counts or view counts (no real review data at build time)', () => {
    for (const p of pages) {
      const blob = JSON.stringify(p.nodes);
      for (const k of [
        'aggregateRating',
        'AggregateRating',
        'ratingValue',
        'ratingCount',
        'reviewCount',
        'interactionStatistic',
        '"review"',
      ])
        expect(blob.includes(k), `${p.route} 含有 ${k}`).toBe(false);
    }
  });

  it('BreadcrumbList on every page except the home page and noindex system pages', () => {
    const exempt = new Set(['/', '/en/', '/404.html', '/offline/']);
    for (const p of pages) {
      if (exempt.has(p.route)) {
        expect(ofType(p, 'BreadcrumbList')).toHaveLength(0);
        continue;
      }
      const b = one(p, 'BreadcrumbList');
      const items = b.itemListElement as { '@type': string; position: number; name: string; item: string }[];
      // Google：至少两项；位置从 1 连续递增；每项有名称与绝对地址
      expect(items.length, p.route).toBeGreaterThanOrEqual(2);
      items.forEach((it, i) => {
        expect(it['@type']).toBe('ListItem');
        expect(it.position).toBe(i + 1);
        expect(text(it.name)).toBe(true);
        expect(isAbs(it.item)).toBe(true);
        expect(it.item.startsWith(SITE)).toBe(true);
      });
      // 英文页面（T7.6）的面包屑从英文首页开始
      expect(items[0].item).toBe(p.route.startsWith('/en/') ? `${SITE}/en/` : `${SITE}/`);
      // 最后一项就是本页（canonical）——分页 / 动态外壳页的 canonical 允许不同
      if (p.canonical && !/\/page\/\d+\/$|\/forum\/t\/$/.test(p.route))
        expect(items.at(-1)!.item).toBe(p.canonical);
    }
  });
});

describe('apps and AI tools: SoftwareApplication', () => {
  const apps = content<{ title: string; price: { model: string; amount?: string } }>('apps');
  const tools = content<{ title: string; price: { model: string; amount?: string } }>('tools');
  const cases = [
    ...[...apps].map(([slug, d]) => ({ route: `/apps/${slug}/`, d, kind: 'app' })),
    ...[...tools].map(([slug, d]) => ({ route: `/ai/${slug}/`, d, kind: 'tool' })),
  ];
  it('covers every app and tool detail page', () => {
    expect(cases.length).toBeGreaterThanOrEqual(38);
  });
  it.each(cases)('$route', ({ route, d }) => {
    const p = page(route);
    const s = one(p, 'SoftwareApplication');
    expect(s.name).toBe(d.title);
    expect(text(s.description)).toBe(true);
    expect(s.url).toBe(`${SITE}${route}`);
    expect(text(s.operatingSystem)).toBe(true);
    expect(s.applicationCategory).toMatch(/Application$/);
    expect(isAbs(s.image)).toBe(true);
    expect((s.author as { name?: string }).name, 'author.name').toBeTruthy();
    // offers 只在价格明确时：免费 → 0；付费且金额可解析才写；其余（免费 + 付费功能、订阅、待定）不写
    const offer = s.offers as { '@type': string; price: string; priceCurrency: string } | undefined;
    if (d.price.model === 'free')
      expect(offer).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'CNY' });
    else if (d.price.model === 'paid' && d.price.amount && /\d/.test(d.price.amount) && offer) {
      expect(offer.price).toMatch(/^\d+(\.\d{1,2})?$/);
      expect(offer.priceCurrency).toMatch(/^[A-Z]{3}$/);
    } else expect(offer, `${route}: 价格不明确却写了 offers`).toBeUndefined();
    if (s.screenshot) for (const u of s.screenshot as string[]) expect(isAbs(u)).toBe(true);
    if (s.datePublished)
      expect(isIsoDate(s.datePublished) || /^\d{4}-\d{2}$/.test(String(s.datePublished))).toBe(true);
  });
});

describe('games: VideoGame', () => {
  const games = content<{ title: string; genre: string }>('games');
  it.each([...games].map(([slug, d]) => ({ route: `/games/${slug}/`, d })))('$route', ({ route, d }) => {
    const g = one(page(route), 'VideoGame');
    expect(g.name).toBe(d.title);
    expect(g.genre).toBe(d.genre);
    expect(text(g.description)).toBe(true);
    expect(g.url).toBe(`${SITE}${route}`);
    expect(isAbs(g.image)).toBe(true);
    expect(g.gamePlatform).toBeTruthy();
    expect(g.operatingSystem).toBe('Web');
    expect(g.applicationCategory).toBe('GameApplication');
    expect((g.author as { name: string }).name).toBeTruthy();
    expect(isIsoDate(g.dateModified)).toBe(true);
    expect(g).not.toHaveProperty('offers'); // 游戏没有标价，不写
  });
});

describe('videos: VideoObject (verified fields only)', () => {
  const videos = content<{ originalTitle: string; published?: string; duration?: string }>('videos');
  it.each([...videos].map(([slug, d]) => ({ route: `/videos/${slug}/`, d })))('$route', ({ route, d }) => {
    const v = one(page(route), 'VideoObject');
    // Google 视频富结果必填：name、thumbnailUrl、uploadDate（只在核实过发布时间时才有）
    expect(v.name).toBe(d.originalTitle);
    expect(text(v.description)).toBe(true);
    const thumbs = v.thumbnailUrl as string[];
    expect(thumbs.length).toBeGreaterThan(0);
    thumbs.forEach((t) => expect(isAbs(t)).toBe(true));
    expect(isAbs(v.embedUrl)).toBe(true);
    if (d.published) expect(v.uploadDate).toBe(d.published);
    else expect(v).not.toHaveProperty('uploadDate');
    if (d.duration) expect(v.duration).toMatch(/^PT(\d+H)?(\d+M)?(\d+S)?$/);
    else expect(v).not.toHaveProperty('duration');
    expect((v.author as { name: string }).name).toBeTruthy();
    for (const c of (v.hasPart as { '@type': string; startOffset: number; url: string }[] | undefined) ??
      []) {
      expect(c['@type']).toBe('Clip');
      expect(Number.isInteger(c.startOffset)).toBe(true);
      expect(isAbs(c.url)).toBe(true);
    }
  });
});

describe('articles: BlogPosting', () => {
  const articles = content<{ title: string; date: string; lastChecked: string }>('articles');
  it.each([...articles].map(([slug, d]) => ({ route: `/articles/${slug}/`, d })))(
    '$route',
    ({ route, d }) => {
      const p = page(route);
      const a = one(p, 'BlogPosting');
      expect(a.headline).toBe(d.title);
      expect(String(a.headline).length).toBeLessThanOrEqual(110);
      expect(isAbs(a.image)).toBe(true);
      expect(isIsoDate(a.datePublished)).toBe(true);
      expect(isIsoDate(a.dateModified)).toBe(true);
      expect(String(a.datePublished).slice(0, 10) <= String(a.dateModified).slice(0, 10)).toBe(true);
      expect(String(a.datePublished)).toMatch(new RegExp(`^${d.date.slice(0, 7)}`));
      const author = a.author as { '@type': string; name: string; url: string };
      expect(author['@type']).toBe('Person');
      expect(text(author.name)).toBe(true);
      expect(isAbs(author.url)).toBe(true);
      const pub = (a.publisher as { '@id': string })['@id'];
      expect(p.nodes.find((n) => n['@id'] === pub)?.['@type']).toBe('Organization');
      expect(a.mainEntityOfPage).toBe(`${SITE}${route}`);
    },
  );
});

describe('other content types and listings', () => {
  it('works are CreativeWork, seeded forum threads are DiscussionForumPosting', () => {
    for (const p of ID_ROUTES(/^\/works\/[^/]+\/$/, 10)) {
      const w = one(p, 'CreativeWork');
      expect(text(w.name)).toBe(true);
      expect(isAbs(w.image)).toBe(true);
    }
    for (const p of ID_ROUTES(/^\/forum\/t\/t-[^/]+\/$/, 5)) {
      const t = one(p, 'DiscussionForumPosting');
      expect(text(t.headline)).toBe(true);
      expect(isIsoDate(t.datePublished)).toBe(true);
      expect((t.author as { name: string }).name).toBeTruthy();
      expect(t.commentCount).toBe((t.comment as unknown[]).length); // 计数 = 页面上真实的回复数
    }
  });
  it('list pages carry a consistent ItemList', () => {
    for (const r of ['/', '/apps/', '/ai/', '/videos/', '/games/', '/articles/', '/works/']) {
      const l = one(page(r), 'ItemList');
      const items = l.itemListElement as { position: number; url: string; name: string }[];
      expect(l.numberOfItems, r).toBe(items.length);
      expect(items.length, r).toBeGreaterThan(0);
      items.forEach((it, i) => {
        expect(it.position).toBe(i + 1);
        expect(isAbs(it.url)).toBe(true);
        expect(text(it.name)).toBe(true);
        expect(byRoute.has(it.url.replace(SITE, '')), `${r} → ${it.url} 不存在`).toBe(true);
      });
    }
  });
});

describe('T7.6 bilingual pages: inLanguage and hreflang', () => {
  const lang = (p: Page) => /<html lang="([^"]+)"/.exec(p.html)?.[1];
  it('every page has one WebPage whose inLanguage matches <html lang>', () => {
    for (const p of pages) {
      const w = one(p, 'WebPage');
      expect(w.inLanguage, p.route).toBe(lang(p));
      expect(lang(p), p.route).toBe(p.route.startsWith('/en/') ? 'en' : 'zh-CN');
    }
  });
  it('English detail pages: SoftwareApplication / VideoGame are inLanguage en; videos keep the video language', () => {
    const en = pages.filter((p) => /^\/en\/(apps|ai|games|videos)\/[^/]+\/$/.test(p.route));
    expect(en.length).toBeGreaterThanOrEqual(70);
    for (const p of en) {
      if (p.route.startsWith('/en/videos/')) expect(one(p, 'VideoObject').inLanguage, p.route).toBe('en');
      else if (p.route.startsWith('/en/games/')) expect(one(p, 'VideoGame').inLanguage, p.route).toBe('en');
      else expect(one(p, 'SoftwareApplication').inLanguage, p.route).toBe('en');
    }
  });
  it('hreflang pairs are reciprocal and include x-default = Chinese', () => {
    const alt = (p: Page) =>
      Object.fromEntries(
        [...p.html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [
          m[1],
          m[2],
        ]),
      );
    let pairs = 0;
    for (const p of pages) {
      const a = alt(p);
      if (!Object.keys(a).length) continue;
      pairs++;
      expect(Object.keys(a).sort(), p.route).toEqual(['en', 'x-default', 'zh-CN']);
      expect(a['x-default']).toBe(a['zh-CN']);
      expect([a.en, a['zh-CN']]).toContain(p.canonical);
      const other = byRoute.get(new URL(a.en === p.canonical ? a['zh-CN'] : a.en).pathname);
      expect(other, `${p.route} → 对应页面不存在`).toBeTruthy();
      expect(alt(other!)).toEqual(a);
    }
    expect(pairs).toBeGreaterThanOrEqual(150);
  });
});
