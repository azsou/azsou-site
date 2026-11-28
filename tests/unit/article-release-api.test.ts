import { describe, expect, it } from 'vitest';
import { createArticleReleaseApi } from '@/lib/data/article-release-api';
import { DataUnavailableError, ValidationError } from '@/lib/data/types';

const ITEM = '839336db-4c59-4813-868b-5d12d494b3b2';
const OP = '3f2c8b7e-6a1d-4c55-9b0e-0d4a5f6e7a81';

type Call = {
  path: string;
  init: { method?: string; requireAuth?: boolean; body?: Record<string, unknown> };
};

function fake(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api = createArticleReleaseApi({
    rest: (async (path: string, init: Call['init']) => {
      const call = { path, init };
      calls.push(call);
      return reply(call);
    }) as never,
    restCount: (async () => 0) as never,
  });
  return { api, calls };
}

const stateRow = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  draft_revision: 1,
  release_version: 0,
  phase: 'draft',
  reviewed_revision: null,
  published_revision: null,
  ...over,
});

const receiptRow = (over: Record<string, unknown> = {}) => ({
  item_id: ITEM,
  release_version: 1,
  phase: 'review',
  published_revision: null,
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  slug: 'sb09-release-check-8ce16f5f',
  action: 'submit_review' as const,
  expectedDraft: 1,
  expectedRelease: 0,
  operationId: OP,
  ...over,
});

describe('文章发布接口：读取状态', () => {
  it('以登录身份调用读取函数，并把行转成驼峰字段', async () => {
    const { api, calls } = fake(() => [stateRow()]);
    await expect(api.read('sb09-release-check-8ce16f5f')).resolves.toEqual({
      itemId: ITEM,
      draftRevision: 1,
      releaseVersion: 0,
      phase: 'draft',
      reviewedRevision: null,
      publishedRevision: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('rpc/az_cms_read_article_release_state');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', requireAuth: true });
    expect(calls[0]!.init.body).toEqual({ p_slug: 'sb09-release-check-8ce16f5f' });
  });

  it('条目不存在时返回 null，不当成错误', async () => {
    const { api } = fake(() => []);
    await expect(api.read('missing-article')).resolves.toBeNull();
  });

  it('接受四种一致的阶段，包括"已发布后又有新草稿送审"', async () => {
    const rows = [
      stateRow({ draft_revision: 2, release_version: 1, phase: 'review', reviewed_revision: 2 }),
      stateRow({
        draft_revision: 2,
        release_version: 2,
        phase: 'review',
        reviewed_revision: 2,
        published_revision: 1,
      }),
      stateRow({ draft_revision: 2, release_version: 3, phase: 'published', published_revision: 2 }),
      stateRow({ draft_revision: 2, release_version: 4, phase: 'withdrawn' }),
    ];
    for (const row of rows) {
      const { api } = fake(() => [row]);
      const state = await api.read('studio-notes');
      expect(state?.phase).toBe(row.phase);
      expect(state?.publishedRevision).toBe(row.published_revision);
    }
  });

  it('回执缺项或自相矛盾时拒绝，不猜测', async () => {
    const bad: Record<string, unknown>[] = [
      { item_id: 'not-a-uuid' },
      { draft_revision: 0 },
      { release_version: -1 },
      { phase: 'live' },
      { release_version: 1 },
      { phase: 'review', release_version: 1, reviewed_revision: null },
      { phase: 'review', release_version: 1, reviewed_revision: 3 },
      { phase: 'published', release_version: 1, published_revision: null },
      { phase: 'published', release_version: 1, reviewed_revision: 1, published_revision: 1 },
      { phase: 'withdrawn', release_version: 1, published_revision: 1 },
      { phase: 'published', release_version: 1, published_revision: 2 },
      { phase: 'review', release_version: 1, reviewed_revision: 1, published_revision: 0 },
    ];
    for (const over of bad) {
      const { api } = fake(() => [stateRow(over)]);
      await expect(api.read('studio-notes'), JSON.stringify(over)).rejects.toBeInstanceOf(
        DataUnavailableError,
      );
    }
    for (const data of [[stateRow(), stateRow()], { rows: [] }, null, 'ok']) {
      const { api } = fake(() => data);
      await expect(api.read('studio-notes')).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });

  it('无效标识在发请求之前就被拒绝', async () => {
    const { api, calls } = fake(() => []);
    for (const slug of ['', 'Upper', 'a_b', '-a', 'a-', 'a--b', 'x'.repeat(81)]) {
      await expect(api.read(slug), slug).rejects.toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('读取失败原样抛出，只请求一次，不自动重试', async () => {
    const boom = new Error('network down');
    const { api, calls } = fake(() => {
      throw boom;
    });
    await expect(api.read('studio-notes')).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });
});

describe('文章发布接口：状态转换', () => {
  it('把期望的草稿版本、发布版本和操作编号原样交给数据库', async () => {
    const { api, calls } = fake(() => [receiptRow()]);
    await expect(api.transition(input())).resolves.toEqual({
      itemId: ITEM,
      releaseVersion: 1,
      phase: 'review',
      publishedRevision: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('rpc/az_cms_transition_article_release');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', requireAuth: true });
    expect(calls[0]!.init.body).toEqual({
      p_slug: 'sb09-release-check-8ce16f5f',
      p_action: 'submit_review',
      p_expected_draft: 1,
      p_expected_release: 0,
      p_operation_id: OP,
    });
  });

  it('四种操作各自要求对应的阶段与发布版本', async () => {
    const cases = [
      [input({ action: 'submit_review' }), receiptRow({ phase: 'review' })],
      [
        input({ action: 'publish', expectedRelease: 1 }),
        receiptRow({ release_version: 2, phase: 'published', published_revision: 1 }),
      ],
      [
        input({ action: 'withdraw', expectedRelease: 2 }),
        receiptRow({ release_version: 3, phase: 'withdrawn' }),
      ],
      [
        input({ action: 'restore_review', expectedRelease: 3 }),
        receiptRow({ release_version: 4, phase: 'review' }),
      ],
    ] as const;
    for (const [req, row] of cases) {
      const { api } = fake(() => [row]);
      await expect(api.transition(req), req.action).resolves.toMatchObject({ phase: row.phase });
    }
  });

  it('送审时保持原来的已发布版本不变', async () => {
    const { api } = fake(() => [receiptRow({ release_version: 3, phase: 'review', published_revision: 1 })]);
    await expect(
      api.transition(input({ action: 'submit_review', expectedDraft: 2, expectedRelease: 2 })),
    ).resolves.toMatchObject({ phase: 'review', publishedRevision: 1 });
  });

  it('数据库回执与请求对不上时拒绝，让页面重新读取', async () => {
    const wrong: [Record<string, unknown>, Record<string, unknown>][] = [
      [input({ action: 'publish', expectedRelease: 1 }), receiptRow({ release_version: 2, phase: 'review' })],
      [
        input({ action: 'publish', expectedRelease: 1 }),
        receiptRow({ release_version: 2, phase: 'published', published_revision: 2 }),
      ],
      [
        input({ action: 'publish', expectedRelease: 1 }),
        receiptRow({ release_version: 2, phase: 'published', published_revision: null }),
      ],
      [
        input({ action: 'withdraw', expectedRelease: 2 }),
        receiptRow({ release_version: 3, phase: 'withdrawn', published_revision: 1 }),
      ],
      [
        input({ action: 'restore_review', expectedRelease: 3 }),
        receiptRow({ release_version: 4, phase: 'review', published_revision: 1 }),
      ],
      [input({ action: 'submit_review' }), receiptRow({ release_version: 2 })],
      [input({ action: 'submit_review' }), receiptRow({ item_id: 'nope' })],
      [
        input({ action: 'submit_review', expectedDraft: 1 }),
        receiptRow({ release_version: 1, published_revision: 2 }),
      ],
    ];
    for (const [req, row] of wrong) {
      const { api } = fake(() => [row]);
      await expect(api.transition(req as never), JSON.stringify([req.action, row])).rejects.toBeInstanceOf(
        DataUnavailableError,
      );
    }
    for (const data of [[], [receiptRow(), receiptRow()], null]) {
      const { api } = fake(() => data);
      await expect(api.transition(input())).rejects.toBeInstanceOf(DataUnavailableError);
    }
  });

  it('无效请求在发请求之前就被拒绝', async () => {
    const { api, calls } = fake(() => [receiptRow()]);
    const bad = [
      { slug: 'Bad Slug' },
      { action: 'delete' },
      { expectedDraft: 0 },
      { expectedDraft: 1.5 },
      { expectedRelease: -1 },
      { expectedRelease: Number.MAX_SAFE_INTEGER + 1 },
      { operationId: 'abc' },
      { operationId: '' },
    ];
    for (const over of bad) {
      await expect(api.transition(input(over) as never), JSON.stringify(over)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it('数据库拒绝（版本冲突等）原样抛出，只请求一次', async () => {
    const conflict = Object.assign(new Error('article draft or release generation changed'), {
      code: 'PT409',
    });
    const { api, calls } = fake(() => {
      throw conflict;
    });
    await expect(api.transition(input())).rejects.toBe(conflict);
    expect(calls).toHaveLength(1);
  });
});
