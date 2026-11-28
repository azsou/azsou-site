/**
 * 文章发布接口（只在后台页面的包里）。
 *
 * 只封装 az_cms_read_article_release_state 与 az_cms_transition_article_release 两个 RPC：
 * 站长在草稿编辑器里送审、发布、下架、恢复为待审，并读回当前发布状态。
 * 不缓存、不自动重试：结果不确定时由页面重新读取，再由站长决定。
 */
import type { AdminRest } from './admin';
import { withMigration } from './admin-repo';
import { DataUnavailableError, UUID_RE, ValidationError, type DataRepository } from './types';

export type ArticleReleaseAction = 'submit_review' | 'publish' | 'withdraw' | 'restore_review';
export type ArticleReleasePhase = 'draft' | 'review' | 'published' | 'withdrawn';

export interface ArticleReleaseState {
  itemId: string;
  draftRevision: number;
  releaseVersion: number;
  phase: ArticleReleasePhase;
  /** 只有 phase 为 review 时有值：被送审的草稿版本 */
  reviewedRevision: number | null;
  /** 访客当前看到的版本；没有则为 null */
  publishedRevision: number | null;
}

export interface ArticleReleaseInput {
  slug: string;
  action: ArticleReleaseAction;
  expectedDraft: number;
  expectedRelease: number;
  operationId: string;
}

export interface ArticleReleaseReceipt {
  itemId: string;
  releaseVersion: number;
  phase: Exclude<ArticleReleasePhase, 'draft'>;
  publishedRevision: number | null;
}

export interface ArticleReleaseApi {
  read(slug: string): Promise<ArticleReleaseState | null>;
  transition(input: ArticleReleaseInput): Promise<ArticleReleaseReceipt>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS: readonly ArticleReleaseAction[] = ['submit_review', 'publish', 'withdraw', 'restore_review'];
const PHASES: readonly ArticleReleasePhase[] = ['draft', 'review', 'published', 'withdrawn'];

const isRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const optionalPositive = (value: unknown): value is number | null => value === null || positive(value);

function badRelease() {
  return new DataUnavailableError('发布状态回执不完整，请先重新读取', { kind: 'bad-response' });
}

function onlyRow(data: unknown): Record<string, unknown> {
  if (!Array.isArray(data) || data.length !== 1 || !isRow(data[0])) throw badRelease();
  return data[0];
}

function validSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length >= 1 && slug.length <= 80 && SLUG_RE.test(slug);
}

function readState(row: Record<string, unknown>): ArticleReleaseState {
  const {
    item_id: itemId,
    draft_revision: draftRevision,
    release_version: releaseVersion,
    phase,
    reviewed_revision: reviewedRevision,
    published_revision: publishedRevision,
  } = row;
  if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) throw badRelease();
  if (!positive(draftRevision)) throw badRelease();
  if (typeof releaseVersion !== 'number' || !Number.isSafeInteger(releaseVersion) || releaseVersion < 0) {
    throw badRelease();
  }
  if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase)) throw badRelease();
  if (!optionalPositive(reviewedRevision) || !optionalPositive(publishedRevision)) throw badRelease();
  if (publishedRevision !== null && publishedRevision > draftRevision) throw badRelease();
  if (phase === 'draft') {
    if (releaseVersion !== 0 || reviewedRevision !== null || publishedRevision !== null) throw badRelease();
  } else {
    if (releaseVersion < 1) throw badRelease();
    if (phase === 'review') {
      if (reviewedRevision === null || reviewedRevision > draftRevision) throw badRelease();
    } else if (reviewedRevision !== null) {
      throw badRelease();
    }
    if (phase === 'published' && publishedRevision === null) throw badRelease();
    if (phase === 'withdrawn' && publishedRevision !== null) throw badRelease();
  }
  return {
    itemId,
    draftRevision,
    releaseVersion,
    phase: phase as ArticleReleasePhase,
    reviewedRevision,
    publishedRevision,
  };
}

const EXPECTED_PHASE: Record<ArticleReleaseAction, ArticleReleaseReceipt['phase']> = {
  submit_review: 'review',
  publish: 'published',
  withdraw: 'withdrawn',
  restore_review: 'review',
};

function readReceipt(row: Record<string, unknown>, input: ArticleReleaseInput): ArticleReleaseReceipt {
  const {
    item_id: itemId,
    release_version: releaseVersion,
    phase,
    published_revision: publishedRevision,
  } = row;
  if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) throw badRelease();
  if (releaseVersion !== input.expectedRelease + 1) throw badRelease();
  if (phase !== EXPECTED_PHASE[input.action]) throw badRelease();
  if (!optionalPositive(publishedRevision)) throw badRelease();
  if (input.action === 'publish' && publishedRevision !== input.expectedDraft) throw badRelease();
  if (input.action === 'withdraw' || input.action === 'restore_review') {
    if (publishedRevision !== null) throw badRelease();
  }
  if (
    input.action === 'submit_review' &&
    publishedRevision !== null &&
    publishedRevision > input.expectedDraft
  ) {
    throw badRelease();
  }
  return {
    itemId,
    releaseVersion: releaseVersion as number,
    phase: phase as ArticleReleaseReceipt['phase'],
    publishedRevision,
  };
}

export function createArticleReleaseApi({ rest }: AdminRest): ArticleReleaseApi {
  const post = (name: string, body: Record<string, unknown>) =>
    rest<unknown>(`rpc/${name}`, { method: 'POST', requireAuth: true, body });
  return {
    async read(slug) {
      if (!validSlug(slug)) throw new ValidationError('文章标识无效');
      const data = await post('az_cms_read_article_release_state', { p_slug: slug });
      if (Array.isArray(data) && data.length === 0) return null;
      return readState(onlyRow(data));
    },
    async transition(input) {
      if (!validSlug(input.slug)) throw new ValidationError('文章标识无效');
      if (!(ACTIONS as readonly string[]).includes(input.action)) throw new ValidationError('发布操作无效');
      if (!positive(input.expectedDraft)) throw new ValidationError('草稿版本无效');
      if (!Number.isSafeInteger(input.expectedRelease) || input.expectedRelease < 0) {
        throw new ValidationError('发布版本无效');
      }
      if (typeof input.operationId !== 'string' || !UUID_RE.test(input.operationId)) {
        throw new ValidationError('操作编号无效');
      }
      const data = await post('az_cms_transition_article_release', {
        p_slug: input.slug,
        p_action: input.action,
        p_expected_draft: input.expectedDraft,
        p_expected_release: input.expectedRelease,
        p_operation_id: input.operationId,
      });
      return readReceipt(onlyRow(data), input);
    },
  };
}

const cache = new WeakMap<DataRepository, ArticleReleaseApi>();

/** 当前仓储的发布接口；适配器不支持后台（内存适配器）时返回 null */
export function articleReleaseApiFor(repo: DataRepository): ArticleReleaseApi | null {
  const raw = repo.adminRest;
  if (!raw) return null;
  let api = cache.get(repo);
  if (!api) {
    api = createArticleReleaseApi({
      rest: <T>(path: string, init?: Parameters<AdminRest['rest']>[1]) =>
        raw.rest<T>(path, init).catch((e: unknown) => {
          throw withMigration(e);
        }),
      restCount: (path, init) => raw.restCount(path, init),
    });
    cache.set(repo, api);
  }
  return api;
}
