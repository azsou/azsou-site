/**
 * 首页构建产物断言（原 tests/unit/home.test.ts 里的 3 条，第六轮 ④ 搬到这里）。
 * 以前它们在单元测试里 `it.skipIf(!html)`：CI 先跑单元、后 build，所以在 CI 里**永远被跳过**；
 * 本机先 build 再跑单元时又因为计数口径错（只数 tile / mini 条目、却数全部徽标）失败 33 vs 46 / 32 vs 45。
 * 现在：CI 在 build 之后跑（npm run test:ld）；没有产物直接失败，不跳过；
 * 徽标按「每个货架条目各自恰好一个」核对，覆盖首页实际渲染的全部条目形态（StoreEntry 的 tile / mini / row + 编辑精选 bento）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const INDEX = 'dist/client/index.html';
if (!fs.existsSync(INDEX)) throw new Error(`没有构建产物 ${INDEX}：先运行 npm run build`);
const html = fs.readFileSync(INDEX, 'utf8');

const BADGE = /class="entry__type entry__type--([a-z-]+)"/g;

/** 首页的货架条目：StoreEntry 渲染的 <article class="entry entry--{form}"> 与 FeaturedBento 的 <li class="bento-tile …"> */
export function shelfEntries(doc: string) {
  const out: { form: string; href: string; badges: string[]; dataType?: string }[] = [];
  for (const m of doc.matchAll(/<article class="entry entry--([a-z]+)"[^>]*>([\s\S]*?)<\/article>/g)) {
    out.push({
      form: m[1],
      href: /href="([^"]+)"/.exec(m[2])?.[1] ?? '',
      badges: [...m[2].matchAll(BADGE)].map((b) => b[1]),
    });
  }
  for (const m of doc.matchAll(
    /<li class="bento-tile[^"]*"[^>]*data-type="([a-z-]+)"[^>]*>([\s\S]*?)<\/li>/g,
  )) {
    out.push({
      form: 'bento',
      href: /href="([^"]+)"/.exec(m[2])?.[1] ?? '',
      badges: [...m[2].matchAll(BADGE)].map((b) => b[1]),
      dataType: m[1],
    });
  }
  return out;
}

describe('首页构建产物', () => {
  it('结构化数据：WebSite + SearchAction、Person、Organization、ItemList', () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const types = ld['@graph'].map((n: { '@type': string }) => n['@type']);
    expect(types).toEqual(expect.arrayContaining(['WebSite', 'Person', 'Organization', 'ItemList']));
    const site = ld['@graph'].find((n: { '@type': string }) => n['@type'] === 'WebSite');
    expect(site.potentialAction['@type']).toBe('SearchAction');
  });

  // P10 T10.7：首页去掉了装饰图标墙、平台胶囊区与大 CTA（纯货架）
  it('首页没有装饰图标墙 / 平台胶囊区 / 大 CTA', () => {
    expect(html).not.toMatch(/class="icon-wall"|class="home-chips"|class="home-cta/);
  });

  it('每个货架条目（tile / mini / row / bento）各自恰好一个类型徽标，徽标总数 = 条目数', () => {
    const entries = shelfEntries(html);
    expect(entries.length).toBeGreaterThan(30);
    const bad = entries.filter((e) => e.badges.length !== 1);
    expect(bad, JSON.stringify(bad.slice(0, 5))).toEqual([]);
    // bento 的徽标类型与卡片 data-type 一致
    for (const e of entries.filter((x) => x.form === 'bento')) expect(e.badges[0], e.href).toBe(e.dataType);
    // 页面上的徽标都属于某个条目（不会有游离徽标，也不会漏数某种新形态）
    expect([...html.matchAll(BADGE)].length).toBe(entries.length);
    // 首页确实同时渲染了这几种形态（形态被删 / 改名时这里先报错，而不是悄悄少数）
    expect(new Set(entries.map((e) => e.form))).toEqual(new Set(['tile', 'mini', 'row', 'bento']));
  });

  // T9.4（DESIGN-SYSTEM §19.3）：首屏图片 eager，其余懒加载；eager 只给小图标，数量有上限
  it('首页 eager 图片只有首屏图标（≤ 32 张小图标），其余懒加载', () => {
    const eager = [...html.matchAll(/<img[^>]*loading="eager"[^>]*>/g)].map((m) => m[0]);
    expect(eager.length).toBeLessThanOrEqual(32);
    for (const tag of eager) expect(tag, tag).toMatch(/class="app-icon-img/);
    expect(html).toMatch(/<img[^>]*loading="lazy"/);
  });
});
