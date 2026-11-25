/**
 * 文章发布面板的纯逻辑：哪些按钮此刻可点、状态文字。不碰 DOM，不发请求。
 * 规则与 db/pilots/article-release.sql 一致：数据库才是最终裁判，这里只避免明显的误点。
 */
import type { ArticleReleaseAction, ArticleReleaseState } from '@/lib/data/article-release-api';

export interface ReleaseView {
  slug: string;
  /** 页面上已保存的草稿版本 */
  revision: number;
  /** 本页有未保存的修改 */
  dirty: boolean;
  /** 编辑器正在读写 */
  busy: boolean;
  needsRead: boolean;
}

export type ReleaseControls = Record<ArticleReleaseAction, boolean>;

export const RELEASE_ACTIONS: readonly ArticleReleaseAction[] = [
  'submit_review',
  'publish',
  'withdraw',
  'restore_review',
];

const NONE: ReleaseControls = {
  submit_review: false,
  publish: false,
  withdraw: false,
  restore_review: false,
};

export function releaseControls(state: ArticleReleaseState | null, view: ReleaseView): ReleaseControls {
  if (!state || view.busy || view.needsRead || view.dirty || state.draftRevision !== view.revision) {
    return { ...NONE };
  }
  const { phase, draftRevision, reviewedRevision, publishedRevision } = state;
  return {
    submit_review:
      phase === 'draft' ||
      (phase === 'review' && reviewedRevision !== draftRevision) ||
      (phase === 'published' && publishedRevision !== draftRevision),
    publish: phase === 'review' && reviewedRevision === draftRevision,
    withdraw: phase === 'published' && publishedRevision !== null,
    restore_review: phase === 'withdrawn',
  };
}

export function releaseSummary(state: ArticleReleaseState | null): string {
  if (!state) return '尚未读取发布状态。';
  const live = state.publishedRevision;
  switch (state.phase) {
    case 'draft':
      return `未送审 · 草稿第 ${state.draftRevision} 版 · 访客不可见`;
    case 'review': {
      const seen = live === null ? '访客不可见' : `访客仍看到第 ${live} 版`;
      const pending =
        state.reviewedRevision === state.draftRevision
          ? `第 ${state.reviewedRevision} 版待发布`
          : `第 ${state.reviewedRevision} 版曾送审，草稿已到第 ${state.draftRevision} 版`;
      return `待审 · ${pending} · ${seen}`;
    }
    case 'published': {
      const ahead =
        live !== null && state.draftRevision > live
          ? ` · 草稿已到第 ${state.draftRevision} 版，尚未送审`
          : '';
      return `已发布第 ${live} 版${ahead}`;
    }
    case 'withdrawn':
      return `已下架 · 草稿第 ${state.draftRevision} 版 · 访客不可见`;
  }
}

export const RELEASE_DONE: Record<ArticleReleaseAction, string> = {
  submit_review: '已送审当前版本。还没有发布。',
  publish: '已发布。访客现在可以看到这一版。',
  withdraw: '已下架。访客不可见；草稿和历史都保留。',
  restore_review: '已恢复为待审。访客仍不可见，需要重新发布。',
};

/** 数据库因状态变化而拒绝的几类报错：不是故障，重新读取即可 */
const CONFLICT_RE =
  /(release generation changed|reviewed explicitly|only a withdrawn|no new draft|no revision is published|operation key already used)/i;

export function releaseFailure(error: unknown): { conflict: boolean; text: string } {
  const conflict = error instanceof Error && CONFLICT_RE.test(error.message);
  return {
    conflict,
    text: conflict
      ? '状态已变化，这次没有提交。已重新读取。'
      : '未能确认提交结果。已重新读取状态；不会自动重试。',
  };
}

export function newOperationId(): string {
  return crypto.randomUUID();
}
