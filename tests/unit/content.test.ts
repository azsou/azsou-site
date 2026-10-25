/** 内容完整性：迁移结果与 V72 数据一致，引用不悬空，不含伪造计数字段 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zhLength } from '@/lib/zh-length';

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
const tools = read('tools');
const art = JSON.parse(fs.readFileSync(path.join(root, 'src/data/art.json'), 'utf8'));

describe('content migration', () => {
  it('keeps the V72 counts: 8 apps, 9 games, 12 works, and all 12 V72 articles (P8 adds new ones)', () => {
    expect(Object.keys(apps)).toHaveLength(legacy.appsCatalog.length);
    expect(Object.keys(games)).toHaveLength(legacy.gamesDetail.length);
    expect(Object.keys(articles).length).toBeGreaterThanOrEqual(legacy.articlesReader.length);
    for (const a of legacy.articlesReader) expect(articles[a.slug], a.slug).toBeTruthy();
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
    const blob = JSON.stringify([apps, tools, games, articles, works]);
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

describe('自研应用：图标、概念图与默认档案（2026-10-25 站长授权代填）', () => {
  it('每个应用都有真实图标家族：1024 PNG 母版 + 512/256/128/64 的 AVIF 与 WebP，且不再是临时图标', () => {
    for (const [slug, a] of Object.entries(apps)) {
      const { icon } = a.data;
      expect(icon.placeholder, slug).toBe(false);
      expect(icon.variants, slug).toBe(true);
      expect(icon.src, slug).toBe(`/apps/icons/${slug}.png`);
      const png = fs.readFileSync(path.join(root, 'public', icon.src));
      expect(png.readUInt32BE(16), `${slug} 宽`).toBe(1024);
      expect(png.readUInt32BE(20), `${slug} 高`).toBe(1024);
      for (const n of [512, 256, 128, 64])
        for (const ext of ['avif', 'webp'])
          expect(
            fs.existsSync(path.join(root, `public/apps/icons/${slug}-${n}.${ext}`)),
            `${slug}-${n}.${ext}`,
          ).toBe(true);
    }
  });
  it('截图是 2–4 张 WebP 概念图：标注 illustrative，alt 写明「概念图」，尺寸与文件一致、单张 ≤ 300 KB', () => {
    for (const [slug, a] of Object.entries(apps)) {
      const shots = a.data.screenshots;
      expect(shots.length, slug).toBeGreaterThanOrEqual(2);
      expect(shots.length, slug).toBeLessThanOrEqual(4);
      for (const s of shots) {
        expect(s.src, slug).toMatch(new RegExp(`^/apps/screens/${slug}/[a-z0-9-]+\\.webp$`));
        expect(s.illustrative, s.src).toBe(true);
        expect(s.alt, s.src).toContain('概念图');
        const buf = fs.readFileSync(path.join(root, 'public', s.src));
        expect(buf.length, s.src).toBeLessThanOrEqual(300 * 1024);
        // WebP VP8/VP8L/VP8X 头里的尺寸
        const kind = buf.toString('ascii', 12, 16);
        const [w, h] =
          kind === 'VP8X'
            ? [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1]
            : kind === 'VP8 '
              ? [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]
              : [(buf.readUInt32LE(21) & 0x3fff) + 1, ((buf.readUInt32LE(21) >> 14) & 0x3fff) + 1];
        expect([w, h], s.src).toEqual([s.width, s.height]);
        if (s.device === 'phone') expect(s.height / s.width, s.src).toBeGreaterThan(2);
        else expect(s.width / s.height, s.src).toBeCloseTo(1.6, 1);
      }
    }
  });
  it('默认档案：免费、保留所有权利、不开源、本地处理的隐私说明；没有下载地址的平台都是「即将推出」', () => {
    for (const [slug, a] of Object.entries(apps)) {
      const d = a.data;
      expect(d.price.model, slug).toBe('free');
      expect(d.license, slug).toBe('保留所有权利（免费使用）');
      expect(d.openSource, slug).toBe(false);
      expect(d.privacy.collects, slug).toEqual([]);
      expect(d.privacy.note, slug).toContain(slug === 'sub2api' ? '仅在本机转发请求' : '所有处理在本地完成');
      for (const p of d.platforms) if (!p.url) expect(p.availability, `${slug}/${p.os}`).toBe('coming-soon');
      // 站长待办只剩：真实下载地址、可选真实截图、核对默认值
      expect(d.ownerTodo.join(), slug).not.toContain('图标');
      expect(d.ownerTodo.join(), slug).toContain('核对默认值');
    }
  });
});

describe('AI 工具（/ai/，第三方）', () => {
  const CATS = ['agent', 'vibe-coding', 'cli', 'ai-bot', 'mcp'];
  it('收录 30 个工具，五个分类都有内容', () => {
    expect(Object.keys(tools)).toHaveLength(30);
    for (const c of CATS)
      expect(Object.values(tools).filter((t) => t.data.categories.includes(c)).length, c).toBeGreaterThan(2);
  });
  it('slug 不与自研应用重名（共用评价、下载计数与 /go/ 中转页），也不与 /ai/ 下的路由冲突', () => {
    for (const slug of Object.keys(tools)) {
      expect(apps[slug], slug).toBeUndefined();
      expect(['category', 'icons', 'page'], slug).not.toContain(slug);
    }
  });
  it('只链官方渠道：每个平台都有 https 地址，没有直链、没有本站托管的安装包', () => {
    for (const [slug, t] of Object.entries(tools)) {
      expect(t.data.developer.type, slug).toBe('third-party');
      expect(t.data.website, slug).toMatch(/^https:\/\//);
      for (const p of t.data.platforms) {
        expect(p.url, `${slug}/${p.os}`).toMatch(/^https:\/\//);
        expect(['official', 'github', 'store', 'web'], `${slug}/${p.os}`).toContain(p.linkType);
        expect(p.url, `${slug}/${p.os}`).not.toMatch(/azsou\.com/);
        if (p.linkType === 'github') expect(p.url, `${slug}/${p.os}`).toMatch(/^https:\/\/github\.com\//);
      }
      if (t.data.openSource) expect(t.data.sourceRepo, slug).toMatch(/^https:\/\/github\.com\//);
    }
  });
  it('原创介绍：一句话简介 40–140 字，正文 3 段以上，注明核对日期与「图标版权归各自所有者」', () => {
    for (const [slug, t] of Object.entries(tools)) {
      expect(t.data.summary.length, slug).toBeGreaterThanOrEqual(40);
      expect(t.data.summary.length, slug).toBeLessThanOrEqual(140);
      expect(t.data.subtitle.length, slug).toBeLessThanOrEqual(30);
      expect((t.body.match(/<p>/g) ?? []).length, slug).toBeGreaterThanOrEqual(3);
      expect(t.body, slug).toContain('图标版权归各自所有者');
      expect(t.data.lastChecked, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['free', 'freemium', 'paid'], slug).toContain(t.data.price.model);
    }
  });
  it('图标存在于本站（256 PNG + 64/128/256 的 AVIF / WebP），不热链外站', () => {
    for (const [slug, t] of Object.entries(tools)) {
      expect(t.data.icon.src, slug).toBe(`/ai/icons/${slug}.png`);
      expect(t.data.icon.variants, slug).toBe(true);
      for (const f of [
        `${slug}.png`,
        ...[64, 128, 256].flatMap((n) => [`${slug}-${n}.avif`, `${slug}-${n}.webp`]),
      ])
        expect(fs.existsSync(path.join(root, 'public/ai/icons', f)), f).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ T9.5 ----
describe('T9.5 zhLength', () => {
  it('汉字 1、拉丁字母 / 数字 / 半角符号 0.5', () => {
    expect(zhLength('应用')).toBe(2);
    expect(zhLength('AI 工具')).toBe(3.5);
    expect(zhLength('Claude Code')).toBe(5.5);
    expect(zhLength('「」，。')).toBe(4);
  });
});
