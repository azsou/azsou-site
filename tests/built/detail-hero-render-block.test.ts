/**
 * 详情页头部「解析到一半先画的一帧」不能出现（桌面 Lighthouse /ai/claude-code/ CLS 0.0289，CI push run 40729377703）。
 *
 * 根因（docs/audits/evidence/ci/lighthouse-detail-hero-cls-2026-10-29.md）：≥ 1200 时操作卡 `.detail-hero__actions`
 * 跨三行 `align-self: center`。Chromium 在 HTML 只解析到操作卡开头（卡里还没有按钮，只剩 32px 内边距）时先画一帧，
 * 卡片居中偏下（y≈202）；内容到齐后卡片 178px 高、回到 y≈147，上移 55px。这一帧正好也是页面变长、滚动条出现、
 * 整个 .shell 横移 7px 的那一帧，影响面积 ≈ 整个视口 × 距离 55/1350 → CLS 0.029–0.036（本机 20 次复现 2 次 0.0357，
 * trace 的 frame_max_distance = 54.8）。
 *
 * 修法（不改最终布局、不改视觉基线）：详情页在 <head> 里放 `<link rel="expect" href="#detail-hero-end" blocking="render">`，
 * 头部最后一个子元素是 `<span id="detail-hero-end" hidden>`——头部（含整张操作卡）解析完之前浏览器不画首帧。
 * 这里核对每个构建出来的详情页：标签在 head 里、只有一个、指向的标记存在且是头部最后一个子元素、hidden。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'dist/client';
if (!fs.existsSync(path.join(ROOT, 'index.html')))
  throw new Error(`没有构建产物 ${ROOT}：先运行 npm run build`);

function htmlFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(p);
    return e.name.endsWith('.html') ? [p] : [];
  });
}

const detailPages = htmlFiles(ROOT)
  .map((f) => ({ f, html: fs.readFileSync(f, 'utf8') }))
  .filter((p) => p.html.includes('data-detail-hero'));

const EXPECT = '<link rel="expect" href="#detail-hero-end" blocking="render">';

describe('详情页头部：首帧渲染阻塞到头部解析完', () => {
  it('应用 / AI 工具 / 游戏详情页都在（不是空集合）', () => {
    const sections = new Set(detailPages.map((p) => path.relative(ROOT, p.f).split(path.sep)[0]));
    expect(sections).toEqual(new Set(['ai', 'apps', 'games']));
    expect(detailPages.length).toBeGreaterThan(40);
  });

  it.each(detailPages.map((p) => [path.relative(ROOT, p.f), p.html]))('%s', (_f, html) => {
    const head = html.slice(0, html.indexOf('</head>'));
    const body = html.slice(html.indexOf('</head>'));
    expect(head.split(EXPECT).length - 1, 'head 里恰好一个 rel=expect 标签').toBe(1);
    expect(body.includes('rel="expect"'), 'rel=expect 只能在 head（body 里不生效）').toBe(false);

    const heroStart = body.indexOf('data-detail-hero');
    const heroEnd = body.indexOf('</header>', heroStart);
    const hero = body.slice(heroStart, heroEnd);
    expect(body.split('id="detail-hero-end"').length - 1, '标记只有一个').toBe(1);
    // 标记必须是头部最后一个子元素：操作卡与链接行都在它之前，它之后直到 </header> 只有空白
    const marker = /<span id="detail-hero-end" hidden><\/span>\s*$/;
    expect(hero, '标记是头部最后一个子元素（hidden）').toMatch(marker);
    expect(hero.indexOf('data-detail-actions'), '操作卡在标记之前').toBeGreaterThan(-1);
    expect(hero.indexOf('data-detail-actions')).toBeLessThan(hero.indexOf('id="detail-hero-end"'));
  });
});
