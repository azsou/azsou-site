import {
  articleReleaseApiFor,
  type ArticleReleaseAction,
  type ArticleReleaseApi,
  type ArticleReleaseState,
} from '@/lib/data/article-release-api';
import { ForbiddenError, NotSignedInError, type DataRepository } from '@/lib/data/types';
import {
  RELEASE_ACTIONS,
  RELEASE_DONE,
  newOperationId,
  releaseControls,
  releaseFailure,
  releaseSummary,
  type ReleaseView,
} from './article-release';

export interface ConfirmSpec {
  title: string;
  body: string[];
  submit: string;
  danger?: boolean;
}

export interface ReleasePanelDeps {
  repo?: DataRepository;
  /** 测试注入；未传时由 repo 创建，两者都没有则面板只显示"没有发布接口" */
  api?: ArticleReleaseApi | null;
  onForbidden: () => void;
  confirm?: (spec: ConfirmSpec) => Promise<boolean>;
  newId?: () => string;
}

export interface ReleasePanel {
  /** 编辑器每次重绘时调用；没有打开的草稿传 null */
  sync(view: ReleaseView | null): void;
  stop(): void;
}

const idle: ReleasePanel = { sync() {}, stop() {} };

async function defaultConfirm(spec: ConfirmSpec) {
  const { formDialog } = await import('./shell');
  return (await formDialog(spec)) !== null;
}

function confirmFor(action: ArticleReleaseAction, state: ArticleReleaseState): ConfirmSpec | null {
  if (action === 'publish') {
    return {
      title: '发布这一版？',
      body: [`第 ${state.draftRevision} 版正文会对访客可见。发布后可随时下架。`],
      submit: '发布',
    };
  }
  if (action === 'withdraw') {
    return {
      title: '下架这篇文章？',
      body: ['访客会立即看不到已发布的版本。草稿和历史都保留。'],
      submit: '下架',
      danger: true,
    };
  }
  return null;
}

export function mountArticleRelease(root: HTMLElement, deps: ReleasePanelDeps): ReleasePanel {
  const panel = root.querySelector<HTMLElement>('[data-article-release]');
  const summary = panel?.querySelector<HTMLElement>('[data-release-summary]');
  const note = panel?.querySelector<HTMLElement>('[data-release-status]');
  const refresh = panel?.querySelector<HTMLButtonElement>('[data-release-refresh]');
  if (!panel || !summary || !note || !refresh) return idle;
  const api = deps.api !== undefined ? deps.api : deps.repo ? articleReleaseApiFor(deps.repo) : null;
  const buttons = new Map<ArticleReleaseAction, HTMLButtonElement>();
  for (const action of RELEASE_ACTIONS) {
    const button = panel.querySelector<HTMLButtonElement>(`[data-release-action="${action}"]`);
    if (button) buttons.set(action, button);
  }
  const ask = deps.confirm ?? defaultConfirm;
  const makeId = deps.newId ?? newOperationId;

  let view: ReleaseView | null = null;
  let state: ArticleReleaseState | null = null;
  let loadedKey = '';
  let reading = false;
  let acting = false;
  let stopped = false;
  let readToken = 0;

  const key = (v: ReleaseView) => `${v.slug}:${v.revision}`;

  function paint() {
    if (stopped || !view) {
      panel!.hidden = true;
      for (const b of buttons.values()) b.disabled = true;
      refresh!.disabled = true;
      return;
    }
    panel!.hidden = false;
    const working = reading || acting;
    panel!.setAttribute('aria-busy', String(working));
    refresh!.disabled = !api || view.revision < 1 || view.busy || working;
    if (!api) {
      summary!.textContent = '当前环境没有发布接口，不能送审或发布。';
    } else if (view.revision < 1) {
      summary!.textContent = '草稿保存后才能送审或发布。';
    } else if (reading && !state) {
      summary!.textContent = '正在读取发布状态…';
    } else {
      const suffix = view.dirty ? ' · 本页有未保存修改，先保存再操作' : '';
      summary!.textContent = releaseSummary(state) + suffix;
    }
    const allowed = api
      ? releaseControls(working ? null : state, view)
      : { submit_review: false, publish: false, withdraw: false, restore_review: false };
    for (const [action, button] of buttons) button.disabled = !allowed[action];
  }

  function failedRead(error: unknown) {
    if (error instanceof NotSignedInError || error instanceof ForbiddenError) {
      deps.onForbidden();
      return;
    }
    note!.textContent = '读取发布状态失败，不能送审或发布。可以点"重新读取状态"。';
  }

  async function read(): Promise<void> {
    const current = view;
    if (!api || !current || current.revision < 1 || stopped) return;
    const mine = ++readToken;
    reading = true;
    paint();
    try {
      const next = await api.read(current.slug);
      if (stopped || mine !== readToken) return;
      state = next;
    } catch (e) {
      if (stopped || mine !== readToken) return;
      state = null;
      failedRead(e);
    } finally {
      if (mine === readToken) {
        reading = false;
        paint();
      }
    }
  }

  async function perform(action: ArticleReleaseAction) {
    const current = view;
    const seen = state;
    if (!api || !current || !seen || acting || reading || stopped) return;
    if (!releaseControls(seen, current)[action]) return;
    const spec = confirmFor(action, seen);
    if (spec) {
      acting = true;
      paint();
      const yes = await ask(spec);
      acting = false;
      if (stopped) return;
      if (!yes) {
        paint();
        return;
      }
      if (!view || key(view) !== key(current) || state !== seen || !releaseControls(seen, view)[action]) {
        note!.textContent = '页面状态在确认期间变化了，这次没有提交。';
        paint();
        return;
      }
    }
    acting = true;
    note!.textContent = '正在提交…';
    paint();
    let finished = false;
    try {
      await api.transition({
        slug: current.slug,
        action,
        expectedDraft: seen.draftRevision,
        expectedRelease: seen.releaseVersion,
        operationId: makeId(),
      });
      finished = true;
    } catch (e) {
      if (e instanceof NotSignedInError || e instanceof ForbiddenError) {
        acting = false;
        deps.onForbidden();
        return;
      }
      if (!stopped) note!.textContent = releaseFailure(e).text;
    } finally {
      acting = false;
    }
    if (stopped) return;
    if (finished) note!.textContent = RELEASE_DONE[action];
    state = null;
    await read();
  }

  for (const [action, button] of buttons) button.addEventListener('click', () => void perform(action));
  refresh.addEventListener('click', () => {
    note!.textContent = '';
    if (!acting && !reading) void read();
  });
  paint();

  return {
    sync(next) {
      if (stopped) return;
      view = next;
      if (!next || next.revision < 1) {
        readToken++;
        reading = false;
        state = null;
        loadedKey = '';
        if (!next) note!.textContent = '';
        paint();
        return;
      }
      if (key(next) !== loadedKey && !acting) {
        loadedKey = key(next);
        state = null;
        void read();
      }
      paint();
    },
    stop() {
      stopped = true;
      readToken++;
      paint();
    },
  };
}
