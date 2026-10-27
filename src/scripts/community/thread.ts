/**
 * 主题页 island：
 *  - 动态主题 /forum/t/?id=<uuid>：整页由数据库渲染（标题、正文、元信息、SEO 标签、JSON-LD）；
 *  - 种子主题 /forum/t/t-xxx/：正文与预置回复静态生成，这里追加数据库回复与回帖框。
 * 两者共用：回复分页、点赞、收藏、举报、编辑/删除自己的内容、版主置顶/锁定/精华/隐藏。
 */
import {
  CATEGORY_NAMES,
  checkLength,
  getRepository,
  LIMITS,
  type Profile,
  type Reply,
  type Thread,
} from '@/lib/data';
import { markdownToText } from '@/lib/markdown';
import { url } from '@/lib/routes';
import { friendlyError } from '@/lib/community-errors';
// 编辑器（含图片上传）按需加载：只读访客不下载（首屏 JS 预算）
const loadEditor = () => import('./editor');
import { bodyNode, likeButton, postNode } from './posts';
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
} from './ui';
import { setStatus } from '../render';

const SITE = 'https://azsou.com';
const PAGE_SIZE = 30;

function setMeta(name: string, content: string, attr: 'name' | 'property' = 'name') {
  let m = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!m) {
    m = document.createElement('meta');
    m.setAttribute(attr, name);
    document.head.append(m);
  }
  m.content = content;
}
function noindex() {
  setMeta('robots', 'noindex,follow');
}

/** 动态主题的 SEO：标题、描述、canonical、OG、DiscussionForumPosting */
export function applyThreadSeo(t: Thread, replies: number) {
  const path = url.forumThread(t.id);
  const desc = markdownToText(t.body, 120) || t.title;
  document.title = `${t.title} · 论坛 · AZ Studio`;
  setMeta('description', desc);
  setMeta('og:title', t.title, 'property');
  setMeta('og:description', desc, 'property');
  setMeta('og:url', SITE + path, 'property');
  document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute('href', SITE + path);
  if (t.published === false) noindex();
  const ld = document.createElement('script');
  ld.type = 'application/ld+json';
  ld.dataset.thread = t.id;
  ld.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: t.title,
    text: markdownToText(t.body, 5000),
    url: SITE + path,
    datePublished: t.createdAt,
    ...(t.editedAt ? { dateModified: t.editedAt } : {}),
    author: {
      '@type': 'Person',
      name: t.author.name,
      ...(t.author.id ? { url: SITE + url.user(t.author.id) } : {}),
    },
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/CommentAction',
      userInteractionCount: replies,
    },
  }).replace(/</g, '\\u003c');
  document.head.append(ld);
}

function flagBadges(t: Thread): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (t.pinned) out.push(h('span', { class: 'badge', text: '置顶' }));
  if (t.featured) out.push(h('span', { class: 'badge badge--accent', text: '精华' }));
  if (t.locked) out.push(h('span', { class: 'badge badge--muted', text: '已锁定' }));
  if (t.published === false) out.push(h('span', { class: 'badge badge--warn', text: '已隐藏' }));
  return out;
}

interface State {
  root: HTMLElement;
  key: string;
  me: Profile | null;
  locked: boolean;
  opId: string | null;
  cursor: string | null;
  loaded: number;
  seedCount: number;
  total: number;
}

function paintCount(s: State) {
  const c = s.root.querySelector('[data-count]');
  if (c) c.textContent = `${s.seedCount + s.total} 条回复`;
}

async function loadReplies(s: State, first: boolean) {
  const repo = getRepository();
  const list = s.root.querySelector<HTMLElement>('[data-list]')!;
  const more = s.root.querySelector<HTMLButtonElement>('[data-more]')!;
  const page = await repo.forum.pageReplies(s.key, {
    limit: PAGE_SIZE,
    cursor: first ? null : s.cursor,
    withHidden: !!s.me,
  });
  const likes = await repo.forum
    .likeSummary(
      'reply',
      page.items.map((r) => r.id),
    )
    .catch(() => ({}));
  for (const r of page.items) list.append(replyNode(s, r, likes));
  s.loaded += page.items.length;
  s.cursor = page.next;
  more.hidden = !page.next;
}

function replyNode(s: State, r: Reply, likes: Record<string, { likes: number; liked: boolean }> = {}) {
  return postNode(r, {
    kind: 'reply',
    me: s.me,
    opId: s.opId,
    locked: s.locked,
    likes,
    onRemoved: () => {
      s.total = Math.max(0, s.total - 1);
      paintCount(s);
    },
  });
}

let composerSeq = 0;
function mountComposer(s: State) {
  void mountComposerAsync(s, ++composerSeq).catch((e) => toastError(e));
}
async function mountComposerAsync(s: State, seq: number) {
  const box = s.root.querySelector<HTMLElement>('[data-composer]')!;
  box.replaceChildren();
  if (s.locked && !isMod(s.me)) {
    box.append(h('p', { class: 'notice notice--info', role: 'note', text: '这个主题已锁定，不能再回复。' }));
    return;
  }
  if (!s.me) {
    box.append(loginPrompt('登录后即可回复。'));
    return;
  }
  if (s.me.banned) {
    box.append(h('p', { class: 'notice notice--error', role: 'note', text: '你的账号已被限制发言。' }));
    return;
  }
  const { createComposer } = await loadEditor();
  if (seq !== composerSeq) return; // 加载期间状态又变了：以最新一次为准
  box.replaceChildren();
  const { form } = createComposer({
    fieldLabel: '写回复',
    limit: LIMITS.replyBody,
    label: '回复',
    draftKey: `reply:${s.key}`,
    submitLabel: '发布回复',
    placeholder: '友善地参与讨论…',
    onSubmit: async (body) => {
      const r = await getRepository().forum.reply(s.key, body);
      s.total += 1;
      paintCount(s);
      if (!s.cursor) {
        const li = replyNode(s, r);
        s.root.querySelector('[data-list]')!.append(li);
        li.scrollIntoView({ block: 'nearest' });
      }
      toast('回复已发布。');
    },
  });
  box.append(form);
}

// ------------------------------------------------------------- 主题操作 ----
function threadActions(s: State, t: Thread, likes: { likes: number; liked: boolean } | undefined) {
  const repo = getRepository();
  const bar = s.root.querySelector<HTMLElement>('[data-thread-actions]')!;
  bar.replaceChildren();
  const mine = !!s.me && t.author.id === s.me.id;
  const mod = isMod(s.me);
  bar.append(likeButton('thread', t.id, likes, s.me));
  bar.append(bookmarkButton(t.id, s.me));
  // A04（0018，默认策略待站长确认）：标题 / 正文只能作者本人编辑；版主改他人内容需管理员带理由的 mod_edit_content
  if (s.me && !s.me.banned && mine && (!t.locked || mod)) {
    const edit = h('button', { type: 'button', class: 'act', 'data-act': 'edit-thread', text: '编辑' });
    edit.addEventListener('click', () => void editThread(s, t).catch((e) => toastError(e)));
    bar.append(edit);
  }
  if (s.me && (mine || mod)) {
    const del = h('button', {
      type: 'button',
      class: 'act act--danger',
      'data-act': 'delete-thread',
      text: '删除',
    });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog('删除这个主题？主题下的全部回复也会一起删除。', '删除主题'))) return;
      try {
        await busy(del, () => repo.forum.deleteThread(t.id));
        toast('主题已删除。');
        location.assign(url.forumCategory(t.category));
      } catch (e) {
        toastError(e);
      }
    });
    bar.append(del);
  }
  if (s.me && !mine) {
    const rep = h('button', { type: 'button', class: 'act', 'data-act': 'report', text: '举报' });
    rep.addEventListener('click', () => void reportDialog('thread', t.id));
    bar.append(rep);
  }
  if (mod) bar.append(modTools(s, t));
}

function bookmarkButton(key: string, me: Profile | null) {
  const repo = getRepository();
  const btn = h('button', { type: 'button', class: 'act', 'data-act': 'bookmark', 'aria-pressed': 'false' });
  let on = false;
  const paint = () => {
    btn.setAttribute('aria-pressed', String(on));
    btn.replaceChildren(h('span', { 'aria-hidden': 'true', text: on ? '★' : '☆' }), on ? ' 已收藏' : ' 收藏');
  };
  paint();
  if (me)
    repo.bookmarks
      .has([key])
      .then((set) => {
        on = set.has(key);
        paint();
      })
      .catch(() => {});
  btn.addEventListener('click', async () => {
    if (!me) {
      toast('登录后才能收藏。', 'error');
      return;
    }
    try {
      await busy(btn, () => (on ? repo.bookmarks.remove(key) : repo.bookmarks.add(key)));
      on = !on;
      paint();
      toast(on ? '已加入收藏。' : '已取消收藏。');
    } catch (e) {
      toastError(e, '收藏失败，请稍后再试。');
    }
  });
  return btn;
}

function modTools(s: State, t: Thread) {
  const repo = getRepository();
  const box = h('div', { class: 'mod-tools', role: 'group', 'aria-label': '版主工具' });
  box.append(h('span', { class: 'mod-tools__label', 'aria-hidden': 'true', text: '版主' }));
  const flags: [keyof Thread & ('pinned' | 'locked' | 'featured' | 'published'), string, string][] = [
    ['pinned', '置顶', '取消置顶'],
    ['featured', '设为精华', '取消精华'],
    ['locked', '锁定', '解锁'],
    ['published', '恢复显示', '隐藏'],
  ];
  for (const [flag, on, off] of flags) {
    const b = h('button', { type: 'button', class: 'act', 'data-mod': flag });
    const val = () => (flag === 'published' ? t.published !== false : !!t[flag]);
    const paint = () => {
      b.textContent = val() ? off : on;
      b.setAttribute('aria-pressed', String(flag === 'published' ? !val() : val()));
    };
    paint();
    b.addEventListener('click', async () => {
      try {
        const next = await busy(b, () => repo.forum.setThreadFlags(t.id, { [flag]: !val() }));
        Object.assign(t, {
          pinned: next.pinned,
          locked: next.locked,
          featured: next.featured,
          published: next.published,
        });
        paint();
        renderHeader(s, t);
        s.locked = !!t.locked;
        mountComposer(s);
        toast('已更新。');
      } catch (e) {
        toastError(e);
      }
    });
    box.append(b);
  }
  return box;
}

function seedModTools(s: State) {
  const repo = getRepository();
  const bar = s.root.querySelector<HTMLElement>('[data-thread-actions]')!;
  const b = h('button', { type: 'button', class: 'act', 'data-mod': 'locked' });
  const paint = () => {
    b.textContent = s.locked ? '解锁' : '锁定';
    b.setAttribute('aria-pressed', String(s.locked));
  };
  paint();
  b.addEventListener('click', async () => {
    try {
      const st = await busy(b, () => repo.forum.setSeedLocked(s.key, !s.locked));
      s.locked = st.locked;
      paint();
      mountComposer(s);
      toast(s.locked ? '主题已锁定。' : '主题已解锁。');
    } catch (e) {
      toastError(e);
    }
  });
  bar.append(
    h(
      'div',
      { class: 'mod-tools', role: 'group', 'aria-label': '版主工具' },
      h('span', { class: 'mod-tools__label', 'aria-hidden': 'true', text: '版主' }),
      b,
    ),
  );
}

function renderHeader(s: State, t: Thread) {
  const cat = s.root.querySelector<HTMLElement>('[data-cat]')!;
  cat.replaceChildren(
    h('a', { href: url.forumCategory(t.category), text: CATEGORY_NAMES[t.category] ?? '论坛' }),
    ...flagBadges(t),
  );
  s.root.querySelector<HTMLElement>('[data-title]')!.textContent = t.title;
  const meta = s.root.querySelector<HTMLElement>('[data-meta]')!;
  meta.replaceChildren(
    t.author.id
      ? h('a', { href: url.user(t.author.id), text: t.author.name })
      : h('span', { text: t.author.name }),
    timeEl(t.createdAt),
  );
  if (t.editedAt) meta.append(h('span', { class: 'comment__edited' }, '已编辑 ', timeEl(t.editedAt)));
}

async function editThread(s: State, t: Thread) {
  const { mountEditor } = await loadEditor();
  const bodyBox = s.root.querySelector<HTMLElement>('[data-body]')!;
  const bar = s.root.querySelector<HTMLElement>('[data-thread-actions]')!;
  const titleId = 'edit-title';
  const title = h('input', {
    id: titleId,
    name: 'title',
    type: 'text',
    maxlength: '120',
    required: true,
    value: t.title,
  });
  title.value = t.title;
  const ta = h('textarea', { id: 'edit-body', name: 'body', rows: '10', required: true });
  const status = h('p', { class: 'notice notice--error form-status', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'btn btn--primary', text: '保存修改' });
  const cancel = h('button', { type: 'button', class: 'btn', text: '取消' });
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: titleId, text: '标题' }), title),
    h('div', { class: 'field' }, h('label', { for: 'edit-body', text: '正文' }), ta),
    status,
    h('div', { class: 'btn-row' }, cancel, save),
  );
  const editor = mountEditor(ta, {
    limit: LIMITS.threadBody,
    label: '正文',
    initial: t.body,
    onSubmitShortcut: () => form.requestSubmit(),
  });
  const original = [...bodyBox.childNodes];
  bodyBox.replaceChildren(form);
  bar.hidden = true;
  title.focus();
  const restore = (nodes: Node[]) => {
    bodyBox.replaceChildren(...nodes);
    bar.hidden = false;
  };
  cancel.addEventListener('click', () => restore(original));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = checkLength(title.value, LIMITS.threadTitle, '标题') ?? editor.validate();
    if (err) {
      status.textContent = err;
      return;
    }
    try {
      const next = await busy(save, () =>
        getRepository().forum.updateThread(t.id, { title: title.value, body: editor.value() }),
      );
      Object.assign(t, {
        title: next.title,
        body: next.body,
        editedAt: next.editedAt ?? new Date().toISOString(),
      });
      renderHeader(s, t);
      restore([bodyNode(t.body)]);
      document.title = `${t.title} · 论坛 · AZ Studio`;
      toast('主题已更新。');
    } catch (er) {
      status.textContent = friendlyError(er);
    }
  });
}

function focusHash(root: HTMLElement) {
  const id = location.hash.slice(1);
  if (!/^r-[\w-]+$/.test(id)) return;
  const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (el) {
    el.classList.add('is-target');
    el.scrollIntoView({ block: 'center' });
  }
}

async function initDynamic(root: HTMLElement) {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const title = root.querySelector<HTMLElement>('[data-title]')!;
  const bodyBox = root.querySelector<HTMLElement>('[data-body]')!;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    noindex();
    title.textContent = '缺少主题编号';
    bodyBox.replaceChildren(h('p', { text: '链接不完整。可以回到论坛首页浏览全部主题。' }));
    bodyBox.removeAttribute('aria-busy');
    root.querySelector<HTMLElement>('[data-replies-section]')!.hidden = true;
    setStatus(root, '', 'online');
    return;
  }
  const repo = getRepository();
  const [t, me, counts] = await Promise.all([
    repo.forum.getThread(id),
    viewer(),
    repo.forum.replyCountsFor([id]).catch(() => ({}) as Record<string, number>),
  ]);
  bodyBox.removeAttribute('aria-busy');
  if (!t) {
    noindex();
    title.textContent = '主题不存在或已被删除';
    bodyBox.replaceChildren(h('p', { text: '它可能已被作者删除，或被版主隐藏。' }));
    root.querySelector<HTMLElement>('[data-replies-section]')!.hidden = true;
    setStatus(root, '', 'online');
    return;
  }
  const s: State = {
    root,
    key: t.id,
    me,
    locked: !!t.locked,
    opId: t.author.id,
    cursor: null,
    loaded: 0,
    seedCount: 0,
    total: counts[t.id] ?? 0,
  };
  renderHeader(s, t);
  bodyBox.replaceChildren(bodyNode(t.body));
  applyThreadSeo(t, s.total);
  const likes = await repo.forum.likeSummary('thread', [t.id]).catch(() => ({}) as Record<string, never>);
  threadActions(s, t, likes[t.id]);
  await loadReplies(s, true);
  if (me) s.total = Math.max(s.total, s.loaded);
  paintCount(s);
  mountComposer(s);
  wireMore(s);
  setStatus(root, '', 'online');
  focusHash(root);
}

async function initSeed(root: HTMLElement) {
  const repo = getRepository();
  const key = root.dataset.threadId!;
  const [me, st, counts] = await Promise.all([
    viewer(),
    repo.forum.seedThread(key).catch(() => null),
    repo.forum.replyCountsFor([key]).catch(() => ({}) as Record<string, number>),
  ]);
  const s: State = {
    root,
    key,
    me,
    locked: !!st?.locked,
    opId: null,
    cursor: null,
    loaded: 0,
    seedCount: root.querySelectorAll('[data-list] [data-source="seed"]').length,
    total: counts[key] ?? 0,
  };
  const bar = root.querySelector<HTMLElement>('[data-thread-actions]')!;
  bar.replaceChildren(bookmarkButton(key, me));
  if (isMod(me) && st) seedModTools(s);
  if (s.locked)
    root.querySelector('[data-cat]')?.append(h('span', { class: 'badge badge--muted', text: '已锁定' }));
  await loadReplies(s, true);
  if (me) s.total = Math.max(s.total, s.loaded);
  paintCount(s);
  mountComposer(s);
  wireMore(s);
  setStatus(root, '', 'online');
  focusHash(root);
}

function wireMore(s: State) {
  const more = s.root.querySelector<HTMLButtonElement>('[data-more]')!;
  more.onclick = async () => {
    try {
      await busy(more, () => loadReplies(s, false));
    } catch (e) {
      toastError(e);
    }
  };
}

export async function initThreadPage(root: HTMLElement) {
  try {
    if (root.dataset.mode === 'dynamic') await initDynamic(root);
    else await initSeed(root);
  } catch {
    const offline = '论坛后端暂时不可达，当前为只读模式。';
    if (root.dataset.mode === 'dynamic') {
      const title = root.querySelector<HTMLElement>('[data-title]')!;
      if (title.textContent?.startsWith('正在加载')) title.textContent = '暂时无法加载这个主题';
      root.querySelector('[data-body]')?.removeAttribute('aria-busy');
    }
    setStatus(root, `${offline}`, 'offline');
  }
}

document.querySelectorAll<HTMLElement>('[data-thread-page]').forEach((r) => void initThreadPage(r));
