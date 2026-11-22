import { describe, expect, it } from 'vitest';
import { slashRedirect } from '../../scripts/lib/slash-redirect.mjs';

const SITE = 'http://127.0.0.1:4321';
const landsOn = (loc: string) => new URL(loc, SITE).origin;

/** I01 / T074 第 3 轮：测试 / 预览静态服务器补尾斜杠的 308 Location 不能变成协议相对地址 */
describe('slashRedirect（scripts/serve.mjs）', () => {
  it('正常路径：补 / 去尾斜杠，保留查询串', () => {
    expect(slashRedirect('/forum', '?cat=tech', 'add')).toBe('/forum/?cat=tech');
    expect(slashRedirect('/robots.txt/', '', 'strip')).toBe('/robots.txt');
    expect(slashRedirect('/%E6%90%9C%E7%B4%A2', '', 'add')).toBe('/%E6%90%9C%E7%B4%A2/');
  });
  it('编码斜杠 / 反斜杠 / 多个开头斜杠：Location 仍落在本站', () => {
    for (const raw of [
      '/%2F/evil.example',
      '/%2f%2fevil.example',
      '//evil.example',
      '/\\evil.example',
      '/%5c%5cevil.example',
      '///evil.example',
    ]) {
      for (const mode of ['add', 'strip'] as const) {
        const loc = slashRedirect(raw, '', mode) as string;
        expect(landsOn(loc), `${raw} ${mode} → ${loc}`).toBe(SITE);
        expect(loc.startsWith('//') || loc.startsWith('/\\'), `${raw} ${mode} → ${loc}`).toBe(false);
      }
    }
  });
});
