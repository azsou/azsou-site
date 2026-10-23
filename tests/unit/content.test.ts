/** 内容完整性：迁移结果与 V72 数据一致，引用不悬空，不含伪造计数字段 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const legacy = JSON.parse(fs.readFileSync(path.join(root, 'legacy/az_data.json'), 'utf8'));
type Entry = { data: Record<string, any>; body: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (dir: string): Record<string, Entry> =>
  Object.fromEntries(
    fs
      .readdirSync(path.join(root, 'src/content', dir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const text = fs.readFileSync(path.join(root, 'src/content', dir, f), 'utf8');
        const [, fm, ...body] = text.split(/^---$/m);
        return [f.replace(/\.md$/, ''), { data: JSON.parse(fm), body: body.join('---').trim() }];
      }),
  );
const apps = read('apps');
const games = read('games');
const articles = read('articles');
const works = read('works');
const art = JSON.parse(fs.readFileSync(path.join(root, 'src/data/art.json'), 'utf8'));

describe('content migration', () => {
  it('keeps the V72 counts: 8 apps, 9 games, 12 articles, 12 works', () => {
    expect(Object.keys(apps)).toHaveLength(legacy.appsCatalog.length);
    expect(Object.keys(games)).toHaveLength(legacy.gamesDetail.length);
    expect(Object.keys(articles)).toHaveLength(legacy.articlesReader.length);
    expect(Object.keys(works)).toHaveLength(legacy.worksDetail.length);
  });
  it('keeps titles identical to V72', () => {
    expect(Object.values(apps).map((a) => a.data.title).sort()).toEqual(legacy.appsCatalog.map((a: { t: string }) => a.t).sort());
    for (const a of legacy.articlesReader) expect(articles[a.slug].data.title).toBe(a.title);
    for (const g of legacy.gamesDetail) expect(games[g.slug].data.title).toBe(g.title);
    for (const w of legacy.worksDetail) expect(works[w.slug].data.title).toBe(w.title);
  });
  it('gives every article a body and matching TOC anchors', () => {
    for (const [slug, a] of Object.entries(articles)) {
      expect(a.body.length, slug).toBeGreaterThan(200);
      a.data.toc.forEach((_: string, i: number) => expect(a.body, `${slug} a-sec-${i + 1}`).toContain(`id="a-sec-${i + 1}"`));
      expect(fs.existsSync(path.join(root, 'public', a.data.ogImage)), a.data.ogImage).toBe(true);
    }
  });
  it('references only existing art slots and content', () => {
    const all: Record<string, Record<string, Entry>> = { app: apps, game: games, article: articles, work: works };
    for (const g of Object.values(games)) expect(art[g.data.art]).toBeTruthy();
    for (const w of Object.values(works)) {
      expect(art[w.data.art]).toBeTruthy();
      for (const r of w.data.related) expect(all[r.type][r.slug], `${r.type}/${r.slug}`).toBeTruthy();
    }
    for (const a of Object.values(apps)) for (const s of a.data.relatedArticles) expect(articles[s]).toBeTruthy();
  });
  it('does not introduce fake metrics (ratings, downloads, user counts)', () => {
    const blob = JSON.stringify([apps, games, articles, works]);
    for (const k of ['rating', 'downloads', 'installs', 'userCount', 'views', 'likes', 'stars']) expect(blob).not.toContain(`"${k}"`);
  });
  it('flags the 7 back-filled app pages for owner review', () => {
    const flagged = Object.entries(apps)
      .filter(([, a]) => a.data.ownerReview)
      .map(([s]) => s);
    expect(flagged).toHaveLength(7);
    expect(flagged).not.toContain('fablemotion');
  });
});
