import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/safe-next';

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
});
