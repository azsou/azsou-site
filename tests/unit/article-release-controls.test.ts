import { describe, expect, it } from 'vitest';
import type { ArticleReleaseState } from '@/lib/data/article-release-api';
import {
  RELEASE_DONE,
  releaseControls,
  releaseFailure,
  releaseSummary,
  type ReleaseView,
} from '@/scripts/admin/article-release';

const ITEM = '839336db-4c59-4813-868b-5d12d494b3b2';

const st = (over: Partial<ArticleReleaseState> = {}): ArticleReleaseState => ({
  itemId: ITEM,
  draftRevision: 1,
  releaseVersion: 0,
  phase: 'draft',
  reviewedRevision: null,
  publishedRevision: null,
  ...over,
});

const view = (over: Partial<ReleaseView> = {}): ReleaseView => ({
  slug: 'sb09-release-check-8ce16f5f',
  revision: 1,
  dirty: false,
  busy: false,
  needsRead: false,
  ...over,
});

const on = (c: ReturnType<typeof releaseControls>) =>
  (Object.keys(c) as (keyof typeof c)[]).filter((k) => c[k]);

describe('发布按钮：此刻哪些可点', () => {
  it('没读到状态时一个都不能点', () => {
    expect(on(releaseControls(null, view()))).toEqual([]);
  });

  it('未送审的草稿只能送审', () => {
    expect(on(releaseControls(st(), view()))).toEqual(['submit_review']);
  });

  it('待审且审的就是当前版本：只能发布（不能重复送审）', () => {
    const s = st({ releaseVersion: 1, phase: 'review', reviewedRevision: 1 });
    expect(on(releaseControls(s, view()))).toEqual(['publish']);
  });

  it('待审后草稿又改了：必须重新送审，不能发布旧的审核', () => {
    const s = st({ draftRevision: 2, releaseVersion: 1, phase: 'review', reviewedRevision: 1 });
    expect(on(releaseControls(s, view({ revision: 2 })))).toEqual(['submit_review']);
  });

  it('已发布且草稿没变：只能下架', () => {
    const s = st({ releaseVersion: 2, phase: 'published', publishedRevision: 1 });
    expect(on(releaseControls(s, view()))).toEqual(['withdraw']);
  });

  it('已发布后草稿有了新版本：可以下架，也可以把新版本送审', () => {
    const s = st({ draftRevision: 2, releaseVersion: 2, phase: 'published', publishedRevision: 1 });
    expect(on(releaseControls(s, view({ revision: 2 })))).toEqual(['submit_review', 'withdraw']);
  });

  it('已下架：只能恢复为待审，不能直接发布', () => {
    const s = st({ releaseVersion: 3, phase: 'withdrawn' });
    expect(on(releaseControls(s, view()))).toEqual(['restore_review']);
  });

  it('本页有未保存修改、正在读写、需要重读、或页面版本落后于数据库时，全部禁用', () => {
    const s = st();
    expect(on(releaseControls(s, view({ dirty: true })))).toEqual([]);
    expect(on(releaseControls(s, view({ busy: true })))).toEqual([]);
    expect(on(releaseControls(s, view({ needsRead: true })))).toEqual([]);
    expect(on(releaseControls(s, view({ revision: 0 })))).toEqual([]);
    expect(on(releaseControls(st({ draftRevision: 2 }), view({ revision: 1 })))).toEqual([]);
  });
});

describe('发布状态文字', () => {
  it('每个阶段都说清访客看到什么', () => {
    expect(releaseSummary(null)).toBe('尚未读取发布状态。');
    expect(releaseSummary(st())).toBe('未送审 · 草稿第 1 版 · 访客不可见');
    expect(releaseSummary(st({ releaseVersion: 1, phase: 'review', reviewedRevision: 1 }))).toBe(
      '待审 · 第 1 版待发布 · 访客不可见',
    );
    expect(
      releaseSummary(
        st({
          draftRevision: 3,
          releaseVersion: 3,
          phase: 'review',
          reviewedRevision: 2,
          publishedRevision: 1,
        }),
      ),
    ).toBe('待审 · 第 2 版曾送审，草稿已到第 3 版 · 访客仍看到第 1 版');
    expect(releaseSummary(st({ releaseVersion: 2, phase: 'published', publishedRevision: 1 }))).toBe(
      '已发布第 1 版',
    );
    expect(
      releaseSummary(st({ draftRevision: 2, releaseVersion: 2, phase: 'published', publishedRevision: 1 })),
    ).toBe('已发布第 1 版 · 草稿已到第 2 版，尚未送审');
    expect(releaseSummary(st({ releaseVersion: 3, phase: 'withdrawn' }))).toBe(
      '已下架 · 草稿第 1 版 · 访客不可见',
    );
  });

  it('完成提示不夸大：送审不等于发布', () => {
    expect(RELEASE_DONE.submit_review).toContain('还没有发布');
    expect(RELEASE_DONE.restore_review).toContain('需要重新发布');
    expect(RELEASE_DONE.withdraw).toContain('访客不可见');
  });
});

describe('失败提示', () => {
  it('状态变化类报错是冲突，不是故障；其余一律说"未能确认"且不自动重试', () => {
    for (const message of [
      'article draft or release generation changed',
      'this revision must be reviewed explicitly',
      'only a withdrawn article can be restored to review',
      'no new draft to submit, or restore is required',
      'no revision is published',
      'release operation key already used for a different request',
    ]) {
      expect(releaseFailure(new Error(message)).conflict, message).toBe(true);
    }
    const other = releaseFailure(new Error('network down'));
    expect(other.conflict).toBe(false);
    expect(other.text).toContain('未能确认');
    expect(other.text).toContain('不会自动重试');
    expect(releaseFailure('weird').conflict).toBe(false);
  });
});
