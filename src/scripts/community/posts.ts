/**
 * 回复 / 评论条目：作者、时间（含「已编辑」）、净化后的 Markdown 正文、操作（赞、编辑、删除、举报、版主隐藏）。
 */
import { getRepository, LIMITS, type Comment, type LikeSummary, type Profile, type Reply } from '@/lib/data';
import { markdownHtml } from '@/lib/sanitize';
import { url } from '@/lib/routes';
import { initials } from '../render';
import { createComposer } from './editor';
import { busy, confirmDialog, h, isMod, reportDialog, timeEl, toast, toastError } from './ui';

export type PostKind = 'reply' | 'comment';
type Post = Reply | Comment;

export interface PostContext {
  kind: PostKind;
  me: Profile | null;
  /** 主题作者（显示「楼主」） */
  opId?: string | null;
  /** 主题已锁定：普通用户不能编辑 */
  locked?: boolean;
  likes?: Record<string, LikeSummary>;
  onRemoved?(id: string): void;
}

export function likeButton(
  target: 'thread' | 'reply' | 'comment',
  id: string,
  sum: LikeSummary | undefined,
  me: Profile | null,
): HTMLButtonElement {
  let state = { likes: sum?.likes ?? 0, liked: !!sum?.liked };
  const btn = h('button', { type: 'button', class: 'act act--like', 'data-act': 'like' });
  const paint = () => {
    // 状态由 aria-pressed 表达；名称就是可见文字「赞 3」
    btn.setAttribute('aria-pressed', String(state.liked));
    btn.replaceChildren(
      h('span', { 'aria-hidden': 'true', text: state.liked ? '♥' : '♡' }),
      ` 赞 ${state.likes}`,
    );
  };
  paint();
  btn.addEventListener('click', async () => {
    if (!me) {
      toast('登录后才能点赞。', 'error');
      return;
    }
    const prev = state;
    state = { liked: !prev.liked, likes: prev.likes + (prev.liked ? -1 : 1) };
    paint();
    try {
      await busy(btn, () =>
        prev.liked ? getRepository().forum.unlike(target, id) : getRepository().forum.like(target, id),
      );
    } catch (e) {
      state = prev;
      paint();
      toastError(e);
    }
  });
  return btn;
}

export function bodyNode(md: string): HTMLElement {
  const d = h('div', { class: 'comment__body ugc' });
  d.innerHTML = markdownHtml(md);
  return d;
}

function authorLink(a: { id: string | null; name: string }): HTMLElement {
  return a.id
    ? h('a', { class: 'comment__author', href: url.user(a.id), text: a.name })
    : h('b', { text: a.name });
}

export function postNode(p: Post, ctx: PostContext): HTMLLIElement {
  const repo = getRepository();
  const mine = !!ctx.me && p.author.id === ctx.me.id;
  const mod = isMod(ctx.me);
  const li = h('li', {
    class: 'comment post',
    id: `${ctx.kind === 'reply' ? 'r' : 'c'}-${p.id}`,
    'data-source': 'db',
    'data-id': p.id,
  });
  if (p.published === false) li.classList.add('is-hidden');
  const head = h('div', { class: 'comment__head' }, authorLink(p.author));
  if (ctx.opId && p.author.id === ctx.opId) head.append(h('span', { class: 'badge', text: '楼主' }));
  head.append(timeEl(p.createdAt));
  const edited = h('span', { class: 'comment__edited' });
  const paintEdited = (at?: string | null) => {
    edited.replaceChildren();
    if (at) edited.append('· 已编辑 ', timeEl(at));
  };
  paintEdited(p.editedAt);
  head.append(edited);
  if (p.published === false)
    head.append(h('span', { class: 'badge badge--warn', text: '已隐藏（仅作者与版主可见）' }));

  let body = bodyNode(p.body);
  const actions = h('div', { class: 'post__actions' });
  const main = h('div', { class: 'post__main' }, head, body, actions);
  li.append(h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(p.author.name) }), main);

  actions.append(likeButton(ctx.kind, p.id, ctx.likes?.[p.id], ctx.me));

  const canEdit = ctx.me && !ctx.me.banned && (mine || mod) && (!ctx.locked || mod);
  if (canEdit) {
    const edit = h('button', { type: 'button', class: 'act', 'data-act': 'edit', text: '编辑' });
    edit.addEventListener('click', () => {
      const lim = ctx.kind === 'reply' ? LIMITS.replyBody : LIMITS.commentBody;
      const { form, editor } = createComposer({
        fieldLabel: ctx.kind === 'reply' ? '编辑回复' : '编辑评论',
        limit: lim,
        label: ctx.kind === 'reply' ? '回复' : '评论',
        initial: p.body,
        submitLabel: '保存',
        rows: 4,
        onCancel: () => {
          form.replaceWith(body);
          actions.hidden = false;
          edit.focus();
        },
        onSubmit: async (v) => {
          const next =
            ctx.kind === 'reply'
              ? await repo.forum.updateReply(p.id, v)
              : await repo.comments.update(p.id, v);
          p.body = next.body;
          const nb = bodyNode(next.body);
          form.replaceWith(nb);
          body = nb;
          paintEdited(next.editedAt ?? new Date().toISOString());
          actions.hidden = false;
          toast('已保存。');
          edit.focus();
        },
      });
      body.replaceWith(form);
      actions.hidden = true;
      editor.focus();
    });
    actions.append(edit);
  }
  if (ctx.me && (mine || mod)) {
    const del = h('button', { type: 'button', class: 'act act--danger', 'data-act': 'delete', text: '删除' });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog(ctx.kind === 'reply' ? '删除这条回复？' : '删除这条评论？', '删除'))) return;
      try {
        await busy(del, () =>
          ctx.kind === 'reply' ? repo.forum.deleteReply(p.id) : repo.comments.remove(p.id),
        );
        li.remove();
        ctx.onRemoved?.(p.id);
        toast('已删除。');
      } catch (e) {
        toastError(e);
      }
    });
    actions.append(del);
  }
  if (mod) {
    const hide = h('button', { type: 'button', class: 'act', 'data-act': 'hide' });
    const paintHide = () => (hide.textContent = p.published === false ? '恢复显示' : '隐藏');
    paintHide();
    hide.addEventListener('click', async () => {
      try {
        const next = await busy<Post>(hide, () =>
          ctx.kind === 'reply'
            ? repo.forum.setReplyPublished(p.id, p.published === false)
            : repo.comments.setPublished(p.id, p.published === false),
        );
        p.published = next.published;
        li.classList.toggle('is-hidden', p.published === false);
        paintHide();
        toast(p.published === false ? '已隐藏。' : '已恢复显示。');
      } catch (e) {
        toastError(e);
      }
    });
    actions.append(hide);
  }
  if (ctx.me && !mine) {
    const rep = h('button', { type: 'button', class: 'act', 'data-act': 'report', text: '举报' });
    rep.addEventListener('click', () => void reportDialog(ctx.kind, p.id));
    actions.append(rep);
  }
  return li;
}
