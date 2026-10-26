/**
 * 评分及评价 island（迁移 0012）：分布条、列表（分页加载）、写 / 改 / 删自己的评价、举报、版主隐藏 / 删除。
 * 用户内容只经 textContent 进入页面。每人每个应用一条由数据库唯一约束保证，前端只做体验层判断。
 */
import type { Profile } from '@/lib/data';
import { getAppStore, REVIEW_LIMITS, type Review, type ReviewStats } from '@/lib/data/app-store';
import { formatRating } from '@/lib/app-store';
import { setStatus } from '../render';
import {
  busy,
  confirmDialog,
  h,
  isMod,
  loginPrompt,
  reportDialog,
  timeEl,
  toast,
  toastError,
  viewer,
} from '../community/ui';
import { paintRating } from './detail-paint';

const PAGE = 10;

export function stars(n: number, label = true): HTMLElement {
  const full = Math.round(n);
  return h('span', {
    class: 'stars',
    role: label ? 'img' : undefined,
    'aria-label': label ? `${n} 星（满分 5 星）` : undefined,
    'aria-hidden': label ? undefined : 'true',
    text: '★'.repeat(full) + '☆'.repeat(5 - full),
  });
}

function paintSummary(root: HTMLElement, s: ReviewStats) {
  const avg = root.querySelector<HTMLElement>('[data-reviews-avg]')!;
  avg.textContent = s.reviews > 0 && s.average !== null ? formatRating(s.average) : '—';
  root.querySelector<HTMLElement>('[data-reviews-count]')!.textContent = `${s.reviews} 条`;
  const max = Math.max(1, ...s.distribution);
  for (let k = 1; k <= 5; k++) {
    const n = s.distribution[k - 1];
    root.querySelector<HTMLElement>(`[data-bar="${k}"]`)?.style.setProperty('--w', `${(n / max) * 100}%`);
    const t = root.querySelector<HTMLElement>(`[data-bar-n="${k}"]`);
    if (t) t.textContent = String(n);
  }
  root.querySelector<HTMLElement>('[data-reviews-empty]')!.hidden = s.reviews > 0;
}

function bodyNode(text: string): HTMLElement {
  const wrap = h('div', { class: 'review__body' });
  for (const block of text.split(/\n{2,}/)) {
    const p = h('p');
    block.split('\n').forEach((line, i) => {
      if (i) p.append(h('br'));
      p.append(line);
    });
    wrap.append(p);
  }
  return wrap;
}

interface Ctx {
  me: Profile | null;
  refresh(): Promise<void>;
  editMine(r: Review): void;
}

export function reviewNode(r: Review, ctx: Ctx): HTMLLIElement {
  const mine = !!ctx.me && ctx.me.id === r.author.id;
  const li = h('li', { class: `review panel${r.published ? '' : ' is-hidden'}`, id: `review-${r.id}` });
  li.dataset.review = r.id;
  const head = h(
    'div',
    { class: 'review__head' },
    stars(r.rating),
    r.title ? h('b', { class: 'review__title', text: r.title }) : null,
  );
  const meta = h(
    'p',
    { class: 'review__meta muted' },
    h('span', { text: r.author.name }),
    ' · ',
    timeEl(r.createdAt),
    r.version ? ` · 版本 ${r.version}` : '',
    r.editedAt ? ' · 已编辑' : '',
    !r.published ? h('span', { class: 'badge badge--muted', text: '已隐藏' }) : null,
  );
  li.append(head, meta);
  if (r.body) li.append(bodyNode(r.body));
  const acts = h('div', { class: 'review__acts' });
  const api = getAppStore();
  if (mine) {
    const edit = h('button', { type: 'button', class: 'act', text: '编辑' });
    edit.addEventListener('click', () => ctx.editMine(r));
    acts.append(edit);
  }
  if (mine || isMod(ctx.me)) {
    const del = h('button', { type: 'button', class: 'act act--danger', text: '删除' });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('删除这条评价？删除后不能恢复。', '删除'))) return;
      try {
        await busy(del, () => api.deleteReview(r.id));
        toast('评价已删除。');
        await ctx.refresh();
      } catch (e) {
        toastError(e);
      }
    });
    acts.append(del);
  }
  if (isMod(ctx.me) && !mine) {
    const hide = h('button', { type: 'button', class: 'act', text: r.published ? '隐藏' : '恢复' });
    hide.addEventListener('click', async () => {
      try {
        await busy(hide, () => api.setPublished(r.id, !r.published));
        toast(r.published ? '已隐藏这条评价。' : '已恢复这条评价。');
        await ctx.refresh();
      } catch (e) {
        toastError(e);
      }
    });
    acts.append(hide);
  }
  if (ctx.me && !mine) {
    const rep = h('button', { type: 'button', class: 'act', 'data-act': 'report', text: '举报' });
    rep.addEventListener('click', () => void reportDialog('review', r.id));
    acts.append(rep);
  }
  if (acts.childElementCount) li.append(acts);
  return li;
}

/** 写 / 改评价的表单：星级是一组单选按钮（键盘可用、屏幕阅读器可读） */
export function reviewForm(opts: {
  initial?: Review | null;
  version: string;
  onSubmit(input: { rating: number; title: string; body: string; version: string }): Promise<void>;
  onCancel?(): void;
}): HTMLFormElement {
  const uid = Math.random().toString(36).slice(2, 8);
  const init = opts.initial;
  const radios = [5, 4, 3, 2, 1].map((k) =>
    h(
      'label',
      { class: 'star-input' },
      h('input', {
        type: 'radio',
        name: `rating-${uid}`,
        value: String(k),
        checked: init?.rating === k,
        required: true,
      }),
      h('span', { 'aria-hidden': 'true', text: '★' }),
      h('span', { class: 'visually-hidden', text: `${k} 星` }),
    ),
  );
  const title = h('input', {
    id: `rt-${uid}`,
    type: 'text',
    maxlength: String(REVIEW_LIMITS.title),
    placeholder: '一句话总结（选填）',
  });
  title.value = init?.title ?? '';
  const body = h('textarea', {
    id: `rb-${uid}`,
    rows: '4',
    maxlength: String(REVIEW_LIMITS.body),
    placeholder: '说说你的使用体验（选填，最多 1000 字）',
  });
  body.value = init?.body ?? '';
  const status = h('p', { class: 'notice notice--error form-status', role: 'alert' });
  const submit = h('button', {
    type: 'submit',
    class: 'btn btn--primary',
    text: init ? '保存修改' : '提交评价',
  });
  const form = h(
    'form',
    { class: 'form review-form panel', 'data-review-form': true, novalidate: true },
    h(
      'fieldset',
      { class: 'star-field' },
      h('legend', { text: init ? '修改你的评分' : '你的评分' }),
      h('div', { class: 'star-row' }, ...radios),
    ),
    h('div', { class: 'field' }, h('label', { for: `rt-${uid}`, text: '标题' }), title),
    h('div', { class: 'field' }, h('label', { for: `rb-${uid}`, text: '评价' }), body),
    status,
    h('div', { class: 'btn-row' }, submit),
  );
  if (opts.onCancel) {
    const cancel = h('button', { type: 'button', class: 'btn', text: '取消' });
    cancel.addEventListener('click', () => opts.onCancel!());
    form.querySelector('.btn-row')!.append(cancel);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = form.querySelector<HTMLInputElement>('input[type=radio]:checked');
    if (!picked) {
      status.textContent = '请先选择 1–5 星。';
      return;
    }
    status.textContent = '';
    try {
      await busy(submit, () =>
        opts.onSubmit({
          rating: Number(picked.value),
          title: title.value,
          body: body.value,
          version: init?.version || opts.version,
        }),
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      status.textContent = /已经提交过/.test(msg) ? '你已经评价过这个应用，可以修改原来的评价。' : '';
      if (!status.textContent) {
        const { friendlyError } = await import('@/lib/community-errors');
        status.textContent = friendlyError(err);
      }
    }
  });
  return form;
}

export async function initReviews(root: HTMLElement, statsReady?: Promise<unknown>) {
  const app = root.dataset.app!;
  const version = root.dataset.version ?? '';
  const api = getAppStore();
  const list = root.querySelector<HTMLElement>('[data-reviews-list]')!;
  const compose = root.querySelector<HTMLElement>('[data-reviews-compose]')!;
  const moreRow = root.querySelector<HTMLElement>('[data-reviews-more-row]')!;
  const moreBtn = root.querySelector<HTMLButtonElement>('[data-reviews-more]')!;
  const page = root.closest<HTMLElement>('[data-app-page]') ?? document;
  let offset = 0;
  let me: Profile | null = null;
  let mine: Review | null = null;

  const ctx: Ctx = {
    me: null,
    refresh: () => load(true),
    editMine: (r) => showComposer(r, true),
  };

  function showComposer(r: Review | null, editing = false) {
    compose.replaceChildren();
    if (!me) {
      compose.append(loginPrompt('登录后即可评分和写评价。'));
      return;
    }
    if (me.banned) {
      compose.append(
        h('p', { class: 'notice notice--error', role: 'note', text: '你的账号已被限制发言，暂时不能评价。' }),
      );
      return;
    }
    if (r && !editing) {
      const edit = h('button', { type: 'button', class: 'btn', text: '修改我的评价' });
      edit.addEventListener('click', () => showComposer(r, true));
      compose.append(
        h(
          'div',
          { class: 'review-mine panel' },
          h('p', {}, '你已给出 ', stars(r.rating), r.published ? '' : '（已被版主隐藏）'),
          edit,
        ),
      );
      return;
    }
    compose.append(
      reviewForm({
        initial: r,
        version,
        onCancel: r ? () => showComposer(r) : undefined,
        onSubmit: async (input) => {
          mine = r ? await api.updateReview(r.id, input) : await api.createReview(app, input);
          toast(r ? '评价已更新。' : '感谢评价！');
          await load(true);
        },
      }),
    );
  }

  async function load(reset: boolean) {
    if (reset) {
      offset = 0;
      list.replaceChildren();
      const s = await api.appStats(app);
      paintSummary(root, s.reviews);
      paintRating(page, s.reviews);
      if (me) mine = await api.myReview(app, me.id).catch(() => mine);
      showComposer(mine);
    }
    const { items, more } = await api.listReviews(app, { offset, limit: PAGE });
    // 自己被隐藏的评价不在公开列表里：单独放在最前面，让作者知道发生了什么
    if (reset && mine && !mine.published) list.append(reviewNode(mine, ctx));
    for (const r of items) list.append(reviewNode(r, ctx));
    offset += items.length;
    moreRow.hidden = !more;
  }

  moreBtn.addEventListener('click', () => void busy(moreBtn, () => load(false)).catch((e) => toastError(e)));

  try {
    await statsReady;
    me = await viewer();
    ctx.me = me;
    await load(true);
    setStatus(root, '', 'online');
  } catch {
    showComposer(null);
    compose.replaceChildren();
    setStatus(root, '评价服务暂时不可达，当前为只读模式。', 'offline');
  }
}
