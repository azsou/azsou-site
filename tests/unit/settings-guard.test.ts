/** A16 / T092 / T095（单元层）：设置写保护的纯逻辑。浏览器层见 tests/e2e/admin-settings-guard.spec.ts。 */
import { describe, expect, it } from 'vitest';
import { mergeSettings, type SettingSlug } from '@/lib/settings';
import { canSave, createSeq, reconcile, sameValue } from '@/lib/settings-guard';

const base = mergeSettings([
  {
    slug: 'announcement',
    data: { enabled: true, text: '真实公告', level: 'warning', link: '', linkText: '' },
  },
]);

describe('设置写保护', () => {
  it('未成功加载（loading / error）一律不能保存', () => {
    expect(canSave('loading', new Set(), 'announcement')).toEqual({ ok: false, reason: 'not-loaded' });
    expect(canSave('error', new Set(), 'registration')).toEqual({ ok: false, reason: 'not-loaded' });
    expect(canSave('loaded', new Set(), 'forum')).toEqual({ ok: true });
    expect(canSave('loaded', new Set<SettingSlug>(['forum']), 'forum')).toEqual({
      ok: false,
      reason: 'conflict',
    });
  });

  it('重新加载：未修改 → apply；修改过且库值未变 → keep；修改过且库值变了 → conflict', () => {
    const changed = mergeSettings([
      {
        slug: 'announcement',
        data: { enabled: true, text: '别人改过', level: 'info', link: '', linkText: '' },
      },
    ]);
    expect(reconcile(base, changed, new Set())).toEqual({
      announcement: 'apply',
      forum: 'apply',
      registration: 'apply',
    });
    expect(reconcile(base, base, new Set<SettingSlug>(['announcement'])).announcement).toBe('keep');
    expect(reconcile(base, changed, new Set<SettingSlug>(['announcement'])).announcement).toBe('conflict');
    // 第一次加载（还没有基线）：全部 apply
    expect(reconcile(null, changed, new Set<SettingSlug>(['announcement'])).announcement).toBe('apply');
  });

  it('比较与键顺序无关；只有最近一次请求有效', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    const s = createSeq();
    const first = s.next();
    const second = s.next();
    expect(s.isCurrent(first)).toBe(false);
    expect(s.isCurrent(second)).toBe(true);
  });
});
