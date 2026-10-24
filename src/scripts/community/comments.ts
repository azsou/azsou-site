/** 文章 / 应用 / 游戏 / 作品页的评论区（page_key 与 V72 一致）：列表、Markdown 评论框、赞、编辑、删除、举报、版主隐藏。 */
import { getRepository, LIMITS } from '@/lib/data';
import { setStatus } from '../render';
import { h, loginPrompt, toast, viewer } from './ui';

async function hydrate(root: HTMLElement) {
  const key = root.dataset.pageKey!;
  const list = root.querySelector<HTMLElement>('[data-list]')!;
  const count = root.querySelector<HTMLElement>('[data-count]');
  const box = root.querySelector<HTMLElement>('[data-composer]')!;
  const seeds = list.querySelectorAll('[data-source="seed"]').length;
  const repo = getRepository();
  let n = 0;
  const paint = () => {
    if (count) count.textContent = `${seeds + n} 条`;
  };
  try {
    const me = await viewer();
    const rows = await repo.comments.list(key, { withHidden: !!me });
    // 有数据库评论时才加载 Markdown 净化与条目渲染（DOMPurify），没有就不下载
    const { postNode } = rows.length || me ? await import('./posts') : { postNode: null };
    const likes = rows.length
      ? await repo.forum
          .likeSummary(
            'comment',
            rows.map((r) => r.id),
          )
          .catch(() => ({}))
      : {};
    const ctx = {
      kind: 'comment' as const,
      me,
      likes,
      onRemoved: () => {
        n -= 1;
        paint();
      },
    };
    for (const r of rows) list.append(postNode!(r, ctx));
    n = rows.filter((r) => r.published !== false).length;
    paint();
    if (!me) box.append(loginPrompt('登录后即可发表评论。'));
    else if (me.banned)
      box.append(h('p', { class: 'notice notice--error', role: 'note', text: '你的账号已被限制发言。' }));
    else {
      const { createComposer } = await import('./editor');
      const { form } = createComposer({
        fieldLabel: '写评论',
        limit: LIMITS.commentBody,
        label: '评论',
        draftKey: `comment:${key}`,
        submitLabel: '发表评论',
        placeholder: '说说你的看法…',
        rows: 4,
        onSubmit: async (body) => {
          const c = await repo.comments.create(key, body);
          list.append(postNode!(c, ctx));
          n += 1;
          paint();
          toast('评论已发表。');
        },
      });
      box.append(form);
    }
    setStatus(root, '', 'online');
  } catch {
    setStatus(root, '数据服务暂时不可达，当前为只读模式：仅显示站点预置内容。', 'offline');
  }
}

document.querySelectorAll<HTMLElement>('[data-comments]').forEach((r) => void hydrate(r));
