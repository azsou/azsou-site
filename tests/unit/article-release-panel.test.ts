// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ArticleReleaseApi,
  ArticleReleaseInput,
  ArticleReleaseState,
} from '@/lib/data/article-release-api';
import { ForbiddenError } from '@/lib/data/types';
import { mountArticleRelease, type ConfirmSpec } from '@/scripts/admin/article-release-panel';

const ITEM = '839336db-4c59-4813-868b-5d12d494b3b2';
const OPS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

const st = (over: Partial<ArticleReleaseState> = {}): ArticleReleaseState => ({
  itemId: ITEM,
  draftRevision: 1,
  releaseVersion: 0,
  phase: 'draft',
  reviewedRevision: null,
  publishedRevision: null,
  ...over,
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const view = (over: Record<string, unknown> = {}) => ({
  slug: 'sb09-release-check-8ce16f5f',
  revision: 1,
  dirty: false,
  busy: false,
  needsRead: false,
  ...over,
});

let root: HTMLElement;
const button = (name: string) => root.querySelector<HTMLButtonElement>(`[data-release-action="${name}"]`)!;
const text = (selector: string) => root.querySelector<HTMLElement>(selector)!.textContent;
const enabled = () =>
  ['submit_review', 'publish', 'withdraw', 'restore_review'].filter((a) => !button(a).disabled);

beforeEach(() => {
  document.body.innerHTML = `<div data-article-draft-editor>
    <section data-article-release hidden>
      <p data-release-summary></p>
      <button type="button" data-release-action="submit_review" disabled>送审</button>
      <button type="button" data-release-action="publish" disabled>发布</button>
      <button type="button" data-release-action="withdraw" disabled>下架</button>
      <button type="button" data-release-action="restore_review" disabled>恢复</button>
      <button type="button" data-release-refresh disabled>重读</button>
      <p data-release-status></p>
    </section></div>`;
  root = document.querySelector<HTMLElement>('[data-article-draft-editor]')!;
});

function fakeApi(
  first: ArticleReleaseState | null,
  next?: (input: ArticleReleaseInput) => ArticleReleaseState | Error,
) {
  const log = { reads: 0, transitions: [] as ArticleReleaseInput[] };
  let current = first;
  const api: ArticleReleaseApi = {
    async read() {
      log.reads++;
      return current;
    },
    async transition(input) {
      log.transitions.push(input);
      const result = next ? next(input) : current;
      if (result instanceof Error) throw result;
      current = result;
      return {
        itemId: ITEM,
        releaseVersion: result!.releaseVersion,
        phase: result!.phase as 'review',
        publishedRevision: result!.publishedRevision,
      };
    },
  };
  return { api, log, set: (s: ArticleReleaseState | null) => (current = s) };
}

function mount(
  api: ArticleReleaseApi | null,
  extra: { confirm?: (s: ConfirmSpec) => Promise<boolean>; forbid?: () => void } = {},
) {
  let n = 0;
  return mountArticleRelease(root, {
    api,
    onForbidden: extra.forbid ?? (() => {}),
    confirm: extra.confirm ?? (async () => true),
    newId: () => OPS[n++ % OPS.length]!,
  });
}

describe('发布面板', () => {
  it('没有打开的草稿时隐藏；新草稿（第 0 版）不读状态、不能操作', async () => {
    const { api, log } = fakeApi(null);
    const panel = mount(api);
    panel.sync(null);
    expect(root.querySelector<HTMLElement>('[data-article-release]')!.hidden).toBe(true);
    panel.sync(view({ revision: 0 }));
    await settle();
    expect(log.reads).toBe(0);
    expect(text('[data-release-summary]')).toBe('草稿保存后才能送审或发布。');
    expect(enabled()).toEqual([]);
  });

  it('打开已保存的草稿后读取一次状态，并只放开合适的按钮', async () => {
    const { api, log } = fakeApi(st());
    const panel = mount(api);
    panel.sync(view());
    panel.sync(view());
    panel.sync(view({ dirty: false }));
    await settle();
    expect(log.reads).toBe(1);
    expect(text('[data-release-summary]')).toBe('未送审 · 草稿第 1 版 · 访客不可见');
    expect(enabled()).toEqual(['submit_review']);
  });

  it('本页有未保存修改时全部禁用，保存成功（版本变）后重新读取', async () => {
    const { api, log, set } = fakeApi(st());
    const panel = mount(api);
    panel.sync(view());
    await settle();
    panel.sync(view({ dirty: true }));
    expect(enabled()).toEqual([]);
    expect(text('[data-release-summary]')).toContain('先保存再操作');
    set(st({ draftRevision: 2 }));
    panel.sync(view({ revision: 2 }));
    expect(enabled()).toEqual([]);
    await settle();
    expect(log.reads).toBe(2);
    expect(enabled()).toEqual(['submit_review']);
  });

  it('送审：带上读到的版本和新的操作编号，成功后重新读取并说明还没发布', async () => {
    const { api, log } = fakeApi(st(), () => st({ releaseVersion: 1, phase: 'review', reviewedRevision: 1 }));
    const panel = mount(api);
    panel.sync(view());
    await settle();
    button('submit_review').click();
    await settle();
    expect(log.transitions).toEqual([
      {
        slug: 'sb09-release-check-8ce16f5f',
        action: 'submit_review',
        expectedDraft: 1,
        expectedRelease: 0,
        operationId: OPS[0],
      },
    ]);
    expect(log.reads).toBe(2);
    expect(text('[data-release-status]')).toContain('还没有发布');
    expect(enabled()).toEqual(['publish']);
  });

  it('发布要先确认；取消则不发请求', async () => {
    const asked: ConfirmSpec[] = [];
    const base = st({ releaseVersion: 1, phase: 'review', reviewedRevision: 1 });
    const cancelled = fakeApi(base);
    const panel = mount(cancelled.api, { confirm: async (s) => (asked.push(s), false) });
    panel.sync(view());
    await settle();
    button('publish').click();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.submit).toBe('发布');
    expect(asked[0]!.danger).toBeUndefined();
    expect(cancelled.log.transitions).toHaveLength(0);
    expect(enabled()).toEqual(['publish']);

    const done = fakeApi(base, () => st({ releaseVersion: 2, phase: 'published', publishedRevision: 1 }));
    const second = mountOnFresh(done.api, async () => true);
    second.sync(view());
    await settle();
    button('publish').click();
    await settle();
    expect(done.log.transitions).toHaveLength(1);
    expect(done.log.transitions[0]).toMatchObject({
      action: 'publish',
      expectedDraft: 1,
      expectedRelease: 1,
    });
    expect(text('[data-release-status]')).toContain('访客现在可以看到');
    expect(enabled()).toEqual(['withdraw']);
  });

  it('下架用危险确认；送审和恢复不弹确认', async () => {
    const asked: ConfirmSpec[] = [];
    const published = st({ releaseVersion: 2, phase: 'published', publishedRevision: 1 });
    const { api, log } = fakeApi(published, () => st({ releaseVersion: 3, phase: 'withdrawn' }));
    const panel = mount(api, { confirm: async (s) => (asked.push(s), true) });
    panel.sync(view());
    await settle();
    button('withdraw').click();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ submit: '下架', danger: true });
    expect(log.transitions[0]).toMatchObject({ action: 'withdraw', expectedRelease: 2 });
    expect(enabled()).toEqual(['restore_review']);
    button('restore_review').click();
    await settle();
    expect(asked).toHaveLength(1);
    expect(log.transitions[1]).toMatchObject({ action: 'restore_review', expectedRelease: 3 });
  });

  it('数据库因状态变化拒绝：只提交一次，提示冲突，并重新读取', async () => {
    const conflict = new Error('article draft or release generation changed');
    const { api, log, set } = fakeApi(st(), () => conflict);
    const panel = mount(api);
    panel.sync(view());
    await settle();
    set(st({ releaseVersion: 1, phase: 'review', reviewedRevision: 1 }));
    button('submit_review').click();
    await settle();
    expect(log.transitions).toHaveLength(1);
    expect(log.reads).toBe(2);
    expect(text('[data-release-status]')).toBe('状态已变化，这次没有提交。已重新读取。');
    expect(enabled()).toEqual(['publish']);
  });

  it('结果不确定的失败：只提交一次，说明未能确认，不自动重试', async () => {
    const { api, log } = fakeApi(st(), () => new Error('network down'));
    const panel = mount(api);
    panel.sync(view());
    await settle();
    button('submit_review').click();
    await settle();
    expect(log.transitions).toHaveLength(1);
    expect(text('[data-release-status]')).toContain('未能确认');
    expect(log.reads).toBe(2);
  });

  it('读取失败时不放开任何按钮，也不拿旧状态顶替', async () => {
    const calls = { n: 0 };
    const api: ArticleReleaseApi = {
      async read() {
        calls.n++;
        throw new Error('down');
      },
      async transition() {
        throw new Error('must not be called');
      },
    };
    const panel = mount(api);
    panel.sync(view());
    await settle();
    expect(enabled()).toEqual([]);
    expect(text('[data-release-status]')).toContain('读取发布状态失败');
    expect(calls.n).toBe(1);
  });

  it('较早发出的读取晚到，不覆盖新版本的状态', async () => {
    const resolvers: ((s: ArticleReleaseState | null) => void)[] = [];
    const api: ArticleReleaseApi = {
      read: () => new Promise((resolve) => resolvers.push(resolve)),
      async transition() {
        throw new Error('unused');
      },
    };
    const panel = mount(api);
    panel.sync(view({ revision: 1 }));
    panel.sync(view({ revision: 2 }));
    resolvers[1]!(st({ draftRevision: 2 }));
    await settle();
    resolvers[0]!(st({ draftRevision: 1, releaseVersion: 1, phase: 'review', reviewedRevision: 1 }));
    await settle();
    expect(text('[data-release-summary]')).toBe('未送审 · 草稿第 2 版 · 访客不可见');
    expect(enabled()).toEqual(['submit_review']);
  });

  it('账号失去权限时通知编辑器关闭草稿', async () => {
    let closed = 0;
    const api: ArticleReleaseApi = {
      async read() {
        throw new ForbiddenError();
      },
      async transition() {
        throw new Error('unused');
      },
    };
    const panel = mount(api, { forbid: () => closed++ });
    panel.sync(view());
    await settle();
    expect(closed).toBe(1);
  });

  it('没有发布接口的环境只显示说明；停用后不再响应', async () => {
    const none = mount(null);
    none.sync(view());
    await settle();
    expect(text('[data-release-summary]')).toBe('当前环境没有发布接口，不能送审或发布。');
    expect(enabled()).toEqual([]);

    document.body.querySelector('[data-article-release]')!.removeAttribute('hidden');
    const { api, log } = fakeApi(st());
    const panel = mount(api);
    panel.sync(view());
    await settle();
    panel.stop();
    panel.sync(view({ revision: 2 }));
    await settle();
    expect(log.reads).toBe(1);
    expect(root.querySelector<HTMLElement>('[data-article-release]')!.hidden).toBe(true);
  });
});

function mountOnFresh(api: ArticleReleaseApi, confirm: (s: ConfirmSpec) => Promise<boolean>) {
  // 同一页面再挂一次会重复绑定点击；先换一份干净的页面结构。
  const clone = root.cloneNode(true) as HTMLElement;
  root.replaceWith(clone);
  root = clone;
  return mountArticleRelease(clone, {
    api,
    onForbidden: () => {},
    confirm,
    newId: () => OPS[1]!,
  });
}
