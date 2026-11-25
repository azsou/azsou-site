import { getRepository } from '@/lib/data';
import { adminApiFor, type ArticleDraftFields } from '@/lib/data/admin-repo';
import { ForbiddenError, NotSignedInError, SchemaMissingError } from '@/lib/data/types';
import { classifySupabaseUrl, supabaseConfig } from '@/lib/supabase-config';
import { matchesImport, readImportPacket } from './article-import-packet';
import { mountArticleRelease } from './article-release-panel';
import { attachPrivateMediaPreview } from './private-media-preview';
import { formDialog, initAdmin, isAdminRole } from './shell';

const validSlug = (s: string) => s.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

type OpenDraft = {
  slug: string;
  itemId: string | null;
  revision: number;
  fields: ArticleDraftFields;
  bodySource: string;
};

async function init() {
  const root = document.querySelector<HTMLElement>('[data-article-draft-editor]');
  if (!root) return;
  const me = await initAdmin();
  if (!me || !isAdminRole(me)) return;
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#draft-${id}`)!;
  const note = find<HTMLElement>('status');
  const target = classifySupabaseUrl(supabaseConfig().url)?.target;
  if (target !== 'test' && target !== 'local') return;
  const repo = getRepository();
  const port = adminApiFor(repo)?.articleDrafts;
  if (!port) {
    note.textContent = '当前环境没有草稿接口，不能保存。';
    return;
  }
  const api = port;
  const owner = me.id;
  attachPrivateMediaPreview(root, repo.auth, owner);
  const release = mountArticleRelease(root, { repo, onForbidden: () => retire() });
  const picker = find<HTMLFormElement>('open-form');
  const form = find<HTMLFormElement>('edit-form');
  const slug = find<HTMLInputElement>('slug');
  const title = find<HTMLInputElement>('title');
  const body = find<HTMLTextAreaElement>('source');
  const version = find<HTMLElement>('version');
  const open = find<HTMLButtonElement>('open');
  const close = find<HTMLButtonElement>('close');
  const save = find<HTMLButtonElement>('save');
  const reload = find<HTMLButtonElement>('reload');
  const file = find<HTMLInputElement>('import-file');
  const hash = find<HTMLInputElement>('import-hash');
  const check = find<HTMLButtonElement>('import-check');
  let staged: Awaited<ReturnType<typeof readImportPacket>> | null = null;
  let doc: OpenDraft | null = null;
  let baseTitle = '';
  let baseBody = '';
  let active = true;
  let busy = false;
  let needsRead = false;
  const dirty = () =>
    doc !== null && (staged !== null || title.value !== baseTitle || body.value !== baseBody);

  function paint() {
    const editing = active && doc !== null;
    slug.disabled = !active || editing || busy;
    open.disabled = !active || editing || busy || !validSlug(slug.value.trim());
    close.hidden = !editing;
    close.disabled = busy || !active;
    form.hidden = !editing;
    title.disabled = body.disabled = !editing;
    title.readOnly = body.readOnly = busy || needsRead || staged !== null;
    file.disabled = hash.disabled = !editing || busy || needsRead || dirty();
    check.disabled = file.disabled || !file.files?.length || !/^[a-f0-9]{64}$/.test(hash.value);
    save.disabled = !editing || busy || needsRead || !dirty() || !title.value.trim();
    reload.disabled = !editing || busy;
    const changed = dirty() ? ' · 本页有未保存修改' : '';
    version.textContent = doc ? `${doc.slug} · 草稿版本 ${doc.revision}${changed}` : '';
    form.setAttribute('aria-busy', String(busy));
    release.sync(
      editing && doc ? { slug: doc.slug, revision: doc.revision, dirty: dirty(), busy, needsRead } : null,
    );
  }

  function address(value: string) {
    history.replaceState(null, '', location.pathname + (value ? `#${value}` : ''));
  }

  function show(value: OpenDraft | null) {
    staged = null;
    file.value = hash.value = '';
    doc = value;
    needsRead = false;
    slug.value = value?.slug ?? '';
    title.value = value?.fields.title ?? '';
    body.value = value?.bodySource ?? '';
    // Controls may normalize newlines. Preserve the original bytes of any untouched field on save.
    baseTitle = title.value;
    baseBody = body.value;
    address(slug.value);
    paint();
  }

  function retire() {
    active = false;
    show(null);
    note.textContent = '账号或权限已变化，已关闭草稿。请重新登录后打开。';
  }

  function allowed() {
    if (active && repo.auth.getSession()?.user.id !== owner) retire();
    return active && root?.isConnected === true;
  }

  async function mayDiscard() {
    if (!dirty()) return true;
    const result = await formDialog({
      title: '放弃本页未保存的修改？',
      body: ['需要保留时，请先取消并复制文字。数据库中的草稿不会被删除。'],
      submit: '放弃本页修改',
      danger: true,
    });
    return result !== null;
  }

  function failed(error: unknown, writing: boolean) {
    if (error instanceof NotSignedInError || error instanceof ForbiddenError) return retire();
    needsRead = doc !== null;
    if (error instanceof SchemaMissingError) {
      note.textContent = '当前环境尚未启用文章草稿服务，无法读写。这里不会改用 Git 或本地存储。';
    } else if (error instanceof Error && /article draft version conflict/i.test(error.message)) {
      note.textContent = '版本冲突：你的文字仍在。请先复制要保留的文字，再重新读取。';
    } else {
      note.textContent = writing
        ? '未能确认保存结果。本页文字仍在；请先复制要保留的文字，再重新读取，不会自动重试。'
        : '读取失败，不能保存。没有用空稿替换你的文字。';
    }
  }

  async function load(key: string) {
    if (!allowed() || busy || !validSlug(key) || (doc && doc.slug !== key)) return;
    busy = true;
    paint();
    try {
      if (!(await mayDiscard()) || !allowed()) return;
      note.textContent = '正在读取草稿…';
      const data = await api.read(key);
      if (!allowed()) return;
      if (doc?.itemId && doc.itemId !== data?.itemId) {
        needsRead = true;
        note.textContent = '原草稿已不存在或标识已被重新使用。请复制文字，关闭后重新打开。';
        return;
      }
      const blank = { slug: key, itemId: null, revision: 0, fields: { title: '' }, bodySource: '' };
      show(data ? { slug: key, ...data } : blank);
      const empty = '这个标识还没有草稿，首次保存后才会建立。';
      note.textContent = data ? `已读取第 ${data.revision} 版草稿。` : empty;
      title.focus();
    } catch (e) {
      if (allowed()) failed(e, false);
    } finally {
      busy = false;
      paint();
    }
  }

  async function compareFile() {
    const current = doc;
    const input = file.files?.[0];
    if (!allowed() || !current || !input || busy || needsRead || dirty() || check.disabled) return;
    const fingerprint = hash.value;
    busy = true;
    paint();
    note.textContent = '正在核对文件与数据库中的草稿…';
    try {
      let packet: Awaited<ReturnType<typeof readImportPacket>>;
      try {
        packet = await readImportPacket(input, current.slug, fingerprint);
      } catch {
        if (allowed()) note.textContent = '文件名、指纹或格式不符；未写入。';
        return;
      }
      if (!allowed() || doc !== current) return;
      const latest = await api.read(current.slug);
      if (!allowed() || doc !== current) return;
      if ((latest?.itemId ?? null) !== current.itemId || (latest?.revision ?? 0) !== current.revision) {
        needsRead = true;
        note.textContent = '草稿状态已变化；请重新读取。未写入。';
        return;
      }
      if (latest) {
        note.textContent = matchesImport(latest, packet)
          ? `全部字段和正文一致，第 ${latest.revision} 版；未写入。`
          : '同一标识已有不同草稿；不覆盖，未写入。';
        return;
      }
      staged = packet;
      title.value = packet.fields.title;
      body.value = packet.bodySource;
      note.textContent = '14 个字段和正文已就绪，尚未写入。请核对标题，再保存私有草稿。';
    } catch (e) {
      if (allowed()) failed(e, false);
    } finally {
      busy = false;
      paint();
    }
  }

  async function persist() {
    if (!allowed() || !doc || busy || needsRead || !dirty() || !title.value.trim()) return;
    const current = doc;
    const nextTitle = title.value === baseTitle ? current.fields.title : title.value.trim();
    const packet = staged;
    if (packet && (current.itemId !== null || current.revision !== 0 || packet.slug !== current.slug)) return;
    const fields = packet?.fields ?? { ...current.fields, title: nextTitle };
    const bodySource = packet?.bodySource ?? (body.value === baseBody ? current.bodySource : body.value);
    busy = true;
    paint();
    note.textContent = '正在保存私有草稿…';
    try {
      const expectedRevision = packet ? 0 : current.revision;
      const input = { slug: current.slug, expectedRevision, fields, bodySource };
      const receipt = await api.save(input);
      if (!allowed()) return;
      if (current.itemId && current.itemId !== receipt.itemId) throw new Error('Unexpected draft identity');
      show({ slug: current.slug, ...receipt, fields, bodySource });
      note.textContent = `草稿已保存，第 ${receipt.revision} 版。未发布。`;
    } catch (e) {
      if (allowed()) failed(e, true);
    } finally {
      busy = false;
      paint();
    }
  }

  picker.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!doc) void load(slug.value.trim());
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void persist();
  });
  check.addEventListener('click', () => void compareFile());
  file.addEventListener('change', paint);
  picker.addEventListener('input', paint);
  form.addEventListener('input', () => {
    if (!doc || busy || needsRead || !allowed()) return;
    paint();
    const text = dirty() ? '有未保存的修改。' : '没有新的修改。';
    if (note.textContent !== text) note.textContent = text;
  });
  reload.addEventListener('click', () => {
    if (doc) void load(doc.slug);
  });
  close.addEventListener('click', async () => {
    if (!allowed() || !doc || busy) return;
    busy = true;
    paint();
    try {
      if (!(await mayDiscard()) || !allowed()) return;
      show(null);
      note.textContent = '草稿已关闭。';
    } finally {
      busy = false;
      paint();
      if (!doc && active) slug.focus();
    }
  });
  repo.auth.onChange((session) => {
    if (active && session?.user.id !== owner) retire();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('pageshow', () => void allowed());
  const remembered = location.hash.slice(1);
  if (validSlug(remembered)) slug.value = remembered;
  paint();
  if (slug.value) await load(slug.value);
}

void init();
