#!/usr/bin/env node
/**
 * 一次性迁移：legacy/az_data.json + legacy/az_assets.json（来自 V72 index.html）
 *   → src/content/{apps,games,articles,works}/*.md（frontmatter 用 JSON 书写，YAML 兼容；正文为原 HTML）
 *   → src/data/*.json（更新、论坛种子、评论种子、素材索引）
 *   → public/art/<slot>.svg（生成式 SVG 素材，拆成可缓存的独立文件）
 * 可重复运行；会覆盖输出（FableMotion 档案为手写，不会被覆盖）。内容以 V72 为准，不新增任何计数或评分。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const legacy = (f) => path.join(root, 'legacy', f);
const data = JSON.parse(fs.readFileSync(legacy('az_data.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(legacy('az_assets.json'), 'utf8'));
const legacyHtml = fs.readFileSync(legacy('index.html'), 'utf8');

const out = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const md = (fm, body = '') => `---\n${JSON.stringify(fm, null, 2)}\n---\n\n${(body || '').trim()}\n`;
const clean = (dir, keep = []) => {
  const p = path.join(root, dir);
  if (fs.existsSync(p))
    for (const f of fs.readdirSync(p)) if (f.endsWith('.md') && !keep.includes(f)) fs.rmSync(path.join(p, f));
};

/* ---------- 1. SVG 素材 ---------- */
const art = {};
for (const [slot, v] of Object.entries(assets)) {
  const svg = Buffer.from(v.src.split(',', 2)[1], 'base64').toString('utf8');
  out(`public/art/${slot}.svg`, svg);
  art[slot] = { src: `/art/${slot}.svg`, alt: v.alt || '' };
}
out('src/data/art.json', JSON.stringify(art, null, 2) + '\n');

/* ---------- 2. 应用 ---------- */
const STATUS = (sc) => sc.replace('status-', '');
const APP_SLUGS = {
  FableMotion: 'fablemotion',
  'Image Atlas Pro': 'image-atlas-pro',
  'Capture Kit': 'capture-kit',
  单文件工具箱: 'single-file-toolbox',
  程序化声场: 'procedural-soundfield',
  职业技能树工具: 'skill-tree-tool',
  Sub2API: 'sub2api',
  'Hermes 回归验收器': 'hermes',
};
const APP_ART = { fablemotion: 'hero-1', 'image-atlas-pro': 'hero-3' };
/* 只在文章标题/正文明确提到时才关联，不臆造 */
const APP_MENTIONS = {
  fablemotion: ['FableMotion'],
  'image-atlas-pro': ['Image Atlas'],
  'capture-kit': ['Capture Kit'],
  'single-file-toolbox': ['单文件工具箱'],
  'procedural-soundfield': ['程序化声场'],
  'skill-tree-tool': ['技能树工具'],
  sub2api: ['Sub2API'],
  hermes: ['Hermes'],
};
const articleText = (a) => a.title + ' ' + (a.body || '');
clean('src/content/apps', ['fablemotion.md']);
data.appsCatalog.forEach((a, i) => {
  const slug = APP_SLUGS[a.t];
  if (slug === 'fablemotion') return; // 手写（见 src/content/apps/fablemotion.md）
  const [version, ...rest] = a.s.split(' · ');
  const updates = data.updates.filter((u) => a.t.startsWith(u.t.split(' ')[0]) || u.t.startsWith(a.t));
  const related = data.articlesReader
    .filter((r) => APP_MENTIONS[slug].some((k) => articleText(r).includes(k)))
    .map((r) => r.slug);
  const fm = {
    title: a.t,
    kind: a.kind,
    icon: a.ic,
    hue: a.hue || 'accent',
    summary: a.p,
    version: version.trim(),
    status: rest.join(' · ') || version,
    statusClass: STATUS(a.sc),
    order: i + 1,
    pinyin: a.py || '',
    art: APP_ART[slug] || null,
    relatedArticles: related,
    updates: updates.map((u) => ({ change: u.rm, kind: u.ck, note: u.rd, date: `2026-${u.tm}` })),
    ownerReview: true,
  };
  const body = [
    `<p>${a.p}</p>`,
    `<p>当前状态：<strong>${a.s}</strong>。以上信息与 V72 站点「应用目录」一致；本页是 v2 迁移时补建的最小档案，版本历史、运行环境与已知问题待作者补充，未核实的信息不会写进来。</p>`,
  ].join('\n');
  out(`src/content/apps/${slug}.md`, md(fm, body));
});

/* ---------- 3. 游戏 ---------- */
clean('src/content/games');
const gridBySlug = Object.fromEntries(data.gamesGrid.map((g) => [g.slug, g]));
data.gamesDetail.forEach((g, i) => {
  const fm = {
    title: g.title,
    kind: g.kind,
    art: g.slot,
    hue: g.hue || 'accent',
    version: g.ver,
    status: g.status,
    date: g.date,
    order: i + 1,
    pinyin: gridBySlug[g.slug]?.py || '',
    genre: (g.facts.find((f) => f[0] === '形态') || [])[1] || '',
    facts: g.facts.map(([label, value]) => ({ label, value })),
    log: g.log.map(([version, date, note]) => ({ version, date, note })),
    issues: g.issues,
  };
  out(`src/content/games/${g.slug}.md`, md(fm, g.intro));
});

/* ---------- 4. 文章 ---------- */
clean('src/content/articles');
const TAGS = {
  开发实践: 'dev-practice',
  FableMotion: 'fablemotion',
  浏览器扩展: 'browser-extension',
  'AI 游戏': 'ai-games',
  实测: 'tested',
  原创: 'original',
  复盘: 'retrospective',
};
const ARTICLE_ART = {
  'fablemotion-s3-timeline': 'article-featured',
  'motion-paths-onion-skin': 'article-motion',
  'chrome-mv3-domain-activation': 'article-extension',
  'emberdeep-skill-tree-migration': 'article-game',
};
function staticArticleBody(slug) {
  // V72 中默认文章（FableMotion S3 复盘）的正文写在静态 HTML 里，AZ_DATA 中为 null
  if (slug !== 'fablemotion-s3-timeline') return '';
  const start = legacyHtml.indexOf('data-view="article"');
  const seg = legacyHtml.slice(start, start + 20000);
  if (!seg.includes('FableMotion S3：从模块化到时间轴终版 UI')) return '';
  const m = seg.match(/<section class="panel article-body">([\s\S]*?)<\/section>/);
  return m ? m[1] : '';
}
const rowBySlug = Object.fromEntries(data.articlesRows.map((r) => [r.slug, r]));
data.articlesReader.forEach((a, i) => {
  const row = rowBySlug[a.slug];
  const [author, date, minutes, checked] = a.meta;
  let body = a.body || staticArticleBody(a.slug);
  if (!body) throw new Error('missing body: ' + a.slug);
  // 旧版 .code div → 语义化 <pre><code>
  body = body.replace(/<div class="code">([\s\S]*?)<\/div>/g, (_, c) => `<pre><code>${c}</code></pre>`);
  const fm = {
    title: a.title,
    category: row.kind,
    badge: a.badge,
    author,
    date,
    lastChecked: checked.replace(/^最后核对：/, ''),
    readingMinutes: parseInt(minutes, 10),
    toc: a.toc,
    tags: [TAGS[row.kind], TAGS[a.badge]].filter(Boolean),
    forumThread: a.forumThread || null,
    ogImage: `/og/${a.slug}.png`,
    art: ARTICLE_ART[a.slug] || null,
    pinyin: row.py || '',
    order: i + 1,
  };
  out(`src/content/articles/${a.slug}.md`, md(fm, body));
});

/* ---------- 5. 作品 ---------- */
clean('src/content/works');
const gameByTitle = Object.fromEntries(data.gamesDetail.map((g) => [g.title, g.slug]));
function relatedLink(r) {
  if (r.article) return { type: 'article', slug: r.article };
  if (r.work) return { type: 'work', slug: r.work };
  if (r.page === 'project') return { type: 'app', slug: 'fablemotion' };
  if (r.page === 'apps') {
    const t = Object.keys(APP_SLUGS).find((k) => r.b.startsWith(k));
    return { type: 'app', slug: APP_SLUGS[t] };
  }
  if (r.page === 'games') {
    const t = Object.keys(gameByTitle).find((k) => r.b.startsWith(k));
    return { type: 'game', slug: gameByTitle[t] };
  }
  throw new Error('unknown related ' + JSON.stringify(r));
}
const galleryBySlug = Object.fromEntries(data.worksGallery.map((w) => [w.slug, w]));
data.worksDetail.forEach((w, i) => {
  const fm = {
    title: w.title,
    kind: w.kind,
    art: w.slot,
    hue: w.hue || 'accent',
    date: w.date,
    status: w.status,
    order: i + 1,
    pinyin: galleryBySlug[w.slug]?.py || '',
    facts: w.facts.map(([label, value]) => ({ label, value })),
    related: w.related.map(relatedLink),
  };
  out(`src/content/works/${w.slug}.md`, md(fm, w.desc));
});

/* ---------- 6. 其他数据 ---------- */
const json = (v) => JSON.stringify(v, null, 2) + '\n';
out(
  'src/data/updates.json',
  json(
    data.updates.map((u) => ({
      title: u.t,
      icon: u.ic,
      hue: u.hue || 'accent',
      change: u.rm,
      kind: u.ck,
      note: u.rd,
      date: `2026-${u.tm}`,
    })),
  ),
);
out(
  'src/data/forum.json',
  json({
    categories: data.forumCategories.map((c) => ({ ...c, art: `forum-${c.id}` })),
    seeds: data.forumSeeds.map((t) => ({
      id: t.id,
      category: data.forumCategories.find((c) => c.name === t.cat).id,
      pinned: !!t.pinned,
      site: !!t.site,
      author: t.who,
      date: t.when,
      title: t.title,
      pinyin: t.py || '',
      body: t.text,
      replies: (t.replies || []).map((r) => ({ author: r.who, date: r.when, body: r.text, site: !!r.site })),
    })),
  }),
);
out(
  'src/data/comment-seeds.json',
  json(
    Object.fromEntries(
      Object.entries(data.commentSeeds).map(([k, list]) => [
        k,
        list.map((c) => ({ author: c.who, date: c.when, body: c.text, site: !!c.site })),
      ]),
    ),
  ),
);
console.log('migrated:', {
  apps: data.appsCatalog.length,
  games: data.gamesDetail.length,
  articles: data.articlesReader.length,
  works: data.worksDetail.length,
  art: Object.keys(art).length,
});
