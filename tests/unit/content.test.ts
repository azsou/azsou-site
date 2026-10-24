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
    expect(
      Object.values(apps)
        .map((a) => a.data.title)
        .sort(),
    ).toEqual(legacy.appsCatalog.map((a: { t: string }) => a.t).sort());
    for (const a of legacy.articlesReader) expect(articles[a.slug].data.title).toBe(a.title);
    for (const g of legacy.gamesDetail) expect(games[g.slug].data.title).toBe(g.title);
    for (const w of legacy.worksDetail) expect(works[w.slug].data.title).toBe(w.title);
  });
  it('gives every article a body and matching TOC anchors', () => {
    for (const [slug, a] of Object.entries(articles)) {
      expect(a.body.length, slug).toBeGreaterThan(200);
      a.data.toc.forEach((_: string, i: number) =>
        expect(a.body, `${slug} a-sec-${i + 1}`).toContain(`id="a-sec-${i + 1}"`),
      );
      expect(fs.existsSync(path.join(root, 'public', a.data.ogImage)), a.data.ogImage).toBe(true);
    }
  });
  it('references only existing art slots and content', () => {
    const all: Record<string, Record<string, Entry>> = {
      app: apps,
      game: games,
      article: articles,
      work: works,
    };
    for (const g of Object.values(games)) expect(art[g.data.art]).toBeTruthy();
    for (const w of Object.values(works)) {
      expect(art[w.data.art]).toBeTruthy();
      for (const r of w.data.related) expect(all[r.type][r.slug], `${r.type}/${r.slug}`).toBeTruthy();
    }
    for (const a of Object.values(apps))
      for (const s of a.data.relatedArticles) expect(articles[s]).toBeTruthy();
  });
  it('does not introduce fake metrics (ratings, downloads, user counts)', () => {
    const blob = JSON.stringify([apps, games, articles, works]);
    for (const k of ['rating', 'downloads', 'installs', 'userCount', 'views', 'likes', 'stars'])
      expect(blob).not.toContain(`"${k}"`);
  });
  it('flags the 7 back-filled app pages for owner review', () => {
    const flagged = Object.entries(apps)
      .filter(([, a]) => a.data.ownerReview)
      .map(([s]) => s);
    expect(flagged).toHaveLength(7);
    expect(flagged).not.toContain('fablemotion');
  });
  it('apps use the P6 store schema with real assets on disk', () => {
    const PLATFORMS = [
      'ios',
      'android',
      'windows',
      'macos',
      'linux',
      'web',
      'cli',
      'browser-ext',
      'ai-bot',
      'mcp',
    ];
    for (const [slug, a] of Object.entries(apps)) {
      const d = a.data;
      expect(fs.existsSync(path.join(root, 'public', d.icon.src)), `${slug} icon`).toBe(true);
      expect(d.subtitle.length, slug).toBeLessThanOrEqual(30);
      expect(d.platforms.length, slug).toBeGreaterThan(0);
      for (const p of d.platforms) {
        expect(PLATFORMS, slug).toContain(p.os);
        if (p.url) expect(p.url, slug).toMatch(/^https:\/\//);
        if (p.linkType === 'direct' && p.url)
          expect(p.sha256, `${slug} direct link needs sha256`).toMatch(/^[0-9a-f]{64}$/i);
      }
      for (const s of d.screenshots ?? []) {
        expect(fs.existsSync(path.join(root, 'public', s.src)), s.src).toBe(true);
        // 生成的界面示意图必须标注 illustrative，文件里也写明「示意图」
        if (
          s.src.endsWith('.svg') &&
          fs.readFileSync(path.join(root, 'public', s.src), 'utf8').includes('示意图')
        )
          expect(s.illustrative, s.src).toBe(true);
      }
    }
  });
  it('flags every placeholder icon and missing asset for the owner (ownerTodo)', () => {
    for (const [slug, a] of Object.entries(apps)) {
      if (a.data.icon.placeholder) {
        expect(fs.readFileSync(path.join(root, 'public', a.data.icon.src), 'utf8'), slug).toContain(
          '临时占位',
        );
        expect(a.data.ownerTodo.join(), slug).toContain('图标');
      }
      if (!a.data.platforms.some((p: { url?: string }) => p.url))
        expect(a.data.ownerTodo.join(), slug).toContain('下载地址');
    }
  });
  it('never uses an app slug that collides with a catalog route', () => {
    for (const slug of Object.keys(apps))
      expect(['page', 'category', 'platform', 'icons', 'screens', 'catalog.json']).not.toContain(slug);
  });
  it('keeps the E2E fixture app out of the real content directory', () => {
    expect(Object.keys(apps)).not.toContain('e2e-fixture');
    expect(fs.existsSync(path.join(root, 'src/content/apps/_e2e/e2e-fixture.md'))).toBe(true);
  });
});
