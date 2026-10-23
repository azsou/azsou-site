import { describe, expect, it } from 'vitest';
import { mapLegacyHash } from '@/lib/hash-redirect';

describe('mapLegacyHash（V72 hash 路由 → v2 真实 URL）', () => {
  it.each([
    ['#/article/pinyin-initial-search', '/articles/pinyin-initial-search/'],
    ['#/game/emberdeep', '/games/emberdeep/'],
    ['#/work/fm-motion-typography', '/works/fm-motion-typography/'],
    ['#/project', '/apps/fablemotion/'],
    ['#project', '/apps/fablemotion/'],
    ['#home', '/'],
    ['#/', '/'],
    ['#/apps', '/apps/'],
    ['#/games', '/games/'],
    ['#/articles', '/articles/'],
    ['#/works', '/works/'],
    ['#/archive', '/archive/'],
    ['#/forum', '/forum/'],
    ['#/forum/t-announce', '/forum/t/t-announce/'],
    ['#/forum/c81da701-f3a9-4232-87a9-009351953263', '/forum/thread/?id=c81da701-f3a9-4232-87a9-009351953263'],
    ['#/login', '/login/'],
    ['#/register', '/register/'],
    ['#/forgot-password', '/reset-password/'],
    ['#/admin', '/admin/'],
    ['#/admin/content', '/admin/'],
    ['#/user/2608d0e3-68e2-4cec-8b73-50dfefa79b82', '/u/?id=2608d0e3-68e2-4cec-8b73-50dfefa79b82'],
  ])('%s → %s', (hash, expected) => {
    expect(mapLegacyHash(hash)).toBe(expected);
  });

  it.each(['', '#', '#main', '#a-sec-1', '#/unknown-view', '#/article/../../etc', '#/article/<script>', '#/%E0%A4%A'])(
    'ignores %s',
    (hash) => {
      expect(mapLegacyHash(hash)).toBeNull();
    },
  );
});
