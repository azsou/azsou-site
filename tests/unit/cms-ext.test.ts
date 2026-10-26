import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { zhLength as siteZhLength } from '@/lib/zh-length';
// 纯 JS 模块（public/cms/，浏览器直接加载；JSDoc 标注类型）
import * as core from '../../public/cms/cms-core.js';

/**
 * T9.17 CMS 体验：字数控件与 schema 同一算法、同一上下限（超字数保存被拦 = 构建也会失败的同一条规则），
 * 图标 / 截图 / 分享图字段都有规格提示，预览模板与控件已注册。
 */
const root = path.resolve(__dirname, '../..');
const cfg = YAML.parse(fs.readFileSync(path.join(root, 'public/cms/config.yml'), 'utf8'));
const schemaSrc = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
type Field = {
  name: string;
  widget?: string;
  min?: number;
  max?: number;
  count?: string;
  hint?: string;
  fields?: Field[];
};
const col = (n: string) => cfg.collections.find((c: { name: string }) => c.name === n).fields as Field[];
const f = (fields: Field[], ...names: string[]): Field =>
  names.reduce<Field>((acc, n) => (acc.fields ?? []).find((x) => x.name === n)!, { name: '', fields });

/** content.config.ts 某个集合定义块里 `<field>: zh(max[, min])` 的上下限 */
function schemaLimit(collection: string, field: string) {
  const start = schemaSrc.indexOf(`const ${collection} = defineCollection`);
  const block = schemaSrc.slice(start, schemaSrc.indexOf('defineCollection', start + 30));
  const m = new RegExp(`\\b${field}: zh\\((\\d+)(?:, (\\d+))?\\)`).exec(block);
  if (!m) throw new Error(`${collection}.${field} 不在 schema 里`);
  return { max: Number(m[1]), min: m[2] ? Number(m[2]) : undefined };
}

describe('T9.17 字数计算', () => {
  it('与站点 zhLength 同一算法', () => {
    for (const s of ['', 'AZ Studio', '一键整理截图', 'Claude Code 命令行', '全角，标点。', 'émoji ✓'])
      expect(core.zhLength(s)).toBe(siteZhLength(s));
  });
  it('超出 / 不足 / 接近上限 / 选填为空', () => {
    expect(core.checkLength('一二三四五六七八九十一二三四五六七', { min: 6, max: 16 })).toMatchObject({
      ok: false,
      state: 'over',
      message: '超出 1 字（上限 16）',
    });
    expect(core.checkLength('短句', { min: 6, max: 16 })).toMatchObject({ ok: false, state: 'short' });
    expect(core.checkLength('一二三四五六七八九十一二三四五', { min: 6, max: 16 })).toMatchObject({
      ok: true,
      state: 'near',
    });
    expect(core.checkLength('', { min: 60, max: 110, required: false })).toMatchObject({
      ok: true,
      state: 'empty',
    });
    expect(core.checkLength('abc', { max: 2, mode: 'chars' })).toMatchObject({
      ok: false,
      message: '超出 1 个字符（上限 2）',
    });
    expect(core.counterText(7.5, { min: 6, max: 16 })).toBe('7.5 / 6–16');
  });
  it('地址与分享卡预览', () => {
    const p = core.pagePreview('tools', { title: 'Claude Code', summary: 'x'.repeat(10) }, 'claude-code');
    expect(p).toMatchObject({
      url: 'https://azsou.com/ai/claude-code/',
      ogImage: '/og/tool/claude-code.png',
      tentative: false,
    });
    expect(p.ogTitle).toBe('Claude Code · AZ Studio');
    const n = core.pagePreview('apps', { title: 'Capture Kit 2' }, '');
    expect(n).toMatchObject({ slug: 'capture-kit-2', tentative: true });
  });
});

describe('T9.17 CMS 字段：上下限与 schema 一致，超字数保存被拦', () => {
  const cases: [string, string, string[], 'zh' | 'chars'][] = [
    ['apps', 'apps', ['title'], 'zh'],
    ['apps', 'apps', ['tagline'], 'zh'],
    ['apps', 'apps', ['summary'], 'zh'],
    ['apps', 'apps', ['developer', 'short'], 'zh'],
    ['tools', 'tools', ['title'], 'zh'],
    ['tools', 'tools', ['tagline'], 'zh'],
    ['tools', 'tools', ['summary'], 'zh'],
    ['tools', 'tools', ['developer', 'short'], 'zh'],
    ['articles', 'articles', ['title'], 'zh'],
    ['articles', 'articles', ['description'], 'zh'],
  ];
  it.each(cases)('%s.%s', (collection, schemaName, names) => {
    const field = f(col(collection), ...names);
    expect(field.widget).toBe('string-count');
    const lim = schemaLimit(schemaName, names[names.length - 1]);
    expect({ max: field.max, min: field.min }).toEqual(lim);
    expect(field.hint, '提示写清「用于哪里 · 字数范围」').toMatch(/·/);
    expect(field.hint).toContain(lim.min ? `${lim.min}–${lim.max}` : `${lim.max}`);
  });
  it('副标题按字符数（schema 为 z.string().max(30)）', () => {
    for (const c of ['apps', 'tools'])
      expect(f(col(c), 'subtitle')).toMatchObject({ widget: 'string-count', max: 30, count: 'chars' });
  });
  it('图片字段有比例 / 尺寸指引；图标字段用带预览的控件', () => {
    for (const c of ['apps', 'tools']) {
      expect(f(col(c), 'icon', 'src').widget).toBe('icon-path');
      expect(f(col(c), 'icon', 'src').hint).toMatch(/1:1/);
    }
    expect(f(col('apps'), 'screenshots', 'src').hint).toMatch(/16:10/);
    expect(f(col('articles'), 'ogImage').hint).toMatch(/1200×630/);
  });
  it('/cms/ 载入扩展脚本（模块、同源，CSP 允许）并注册三套预览与两个控件；顶栏说明发布流程', () => {
    const html = fs.readFileSync(path.join(root, 'public/cms/index.html'), 'utf8');
    expect(html).toContain('<script type="module" src="/cms/cms-ext.js"></script>');
    expect(html).toContain('编辑后会开 PR，由站长合并');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    const ext = fs.readFileSync(path.join(root, 'public/cms/cms-ext.js'), 'utf8');
    for (const c of ['apps', 'tools', 'articles']) expect(ext).toContain(`registerPreviewTemplate('${c}'`);
    for (const w of ['string-count', 'icon-path']) expect(ext).toContain(`registerWidget('${w}'`);
    expect(ext).toContain("registerPreviewStyle('/cms/preview.css')");
    expect(ext).toMatch(/isValid\(\)/);
  });
});
