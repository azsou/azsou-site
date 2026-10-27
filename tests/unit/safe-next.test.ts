import { describe, expect, it } from 'vitest';
import { safeNext, sameOriginTarget } from '@/lib/safe-next';
import { BENIGN_DOT_NEXT, EVIL_NEXT } from '../redirect-vectors';

const SITE = 'https://azsou.com';
/** 结果交给浏览器导航时实际落到哪个源 */
const landsOn = (path: string) => new URL(path, SITE).origin;

/** I01 / T074：登录后的跳转只允许本站路径 */
describe('safeNext', () => {
  it('本站路径原样保留（含查询与锚点）', () => {
    expect(safeNext('/forum/')).toBe('/forum/');
    expect(safeNext('/forum/new/?cat=tech')).toBe('/forum/new/?cat=tech');
    expect(safeNext('/settings/?welcome=1#name')).toBe('/settings/?welcome=1#name');
    expect(safeNext('/搜索/?q=%E4%B8%AD')).toBe('/%E6%90%9C%E7%B4%A2/?q=%E4%B8%AD');
  });
  it('外域与伪装成站内路径的地址一律退回默认值', () => {
    for (const raw of [
      'https://evil.example/',
      '//evil.example/x',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n/evil.example',
      '/\t\\evil.example',
      ' //evil.example',
      '/%0a/evil.example'.replace('%0a', '\u000b'),
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ])
      expect(safeNext(raw as string, '/x/'), JSON.stringify(raw)).toBe('/x/');
  });
  it('不回到登录 / 注册 / 回调页（避免循环）', () => {
    expect(safeNext('/login/')).toBe('/');
    expect(safeNext('/auth/callback/?next=/')).toBe('/');
    expect(safeNext('/register/', '/settings/')).toBe('/settings/');
  });

  it('第 3 轮：点段 / 编码点 / 编码斜杠 / 反斜杠混用 / 编码控制字符——全部退回默认值', () => {
    const bad: string[] = [];
    for (const raw of EVIL_NEXT) {
      const out = safeNext(raw, '/x/');
      if (out !== '/x/') bad.push(`${JSON.stringify(raw)} → ${out}（落到 ${landsOn(out)}）`);
    }
    expect(bad).toEqual([]);
  });
  it('返回规范化后的路径，而不是原始输入；结果永远落在本站', () => {
    for (const [raw, want] of BENIGN_DOT_NEXT) expect(safeNext(raw), raw).toBe(want);
    for (const raw of [...EVIL_NEXT, ...BENIGN_DOT_NEXT.map(([r]) => r)]) {
      const out = safeNext(raw);
      expect(landsOn(out), raw).toBe(SITE);
      expect(out.startsWith('//') || out.startsWith('/\\'), raw).toBe(false);
    }
  });
});

/** 最终导航前的同源校验：即使上游给了坏值，导航时也拒绝 */
describe('sameOriginTarget', () => {
  it('本站路径通过（含查询与锚点）', () => {
    expect(sameOriginTarget('/forum/', SITE)).toBe('/forum/');
    expect(sameOriginTarget('/settings/?welcome=1#n', SITE)).toBe('/settings/?welcome=1#n');
    expect(sameOriginTarget('/reset-password/?mode=update', SITE)).toBe('/reset-password/?mode=update');
  });
  it('任何会离开本站的目标都换成默认值', () => {
    for (const raw of [
      '//evil.example',
      '///evil.example',
      '/\\evil.example',
      'https://evil.example/',
      ...EVIL_NEXT,
    ]) {
      const out = sameOriginTarget(raw, SITE, '/');
      expect(landsOn(out), JSON.stringify(raw)).toBe(SITE);
      expect(out.startsWith('//'), JSON.stringify(raw)).toBe(false);
    }
    expect(sameOriginTarget('//evil.example', SITE, '/fallback/')).toBe('/fallback/');
  });
});
