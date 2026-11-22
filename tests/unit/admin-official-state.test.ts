// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAdmin } from '@/scripts/admin/shell';
import { initOfficial } from '@/scripts/admin/official';

vi.mock('@/scripts/admin/shell', () => ({ initAdmin: vi.fn() }));

const source = readFileSync(join(import.meta.dirname, '../../src/pages/admin/official/index.astro'), 'utf8');
const gate = vi.mocked(initAdmin);
type GateResult = Awaited<ReturnType<typeof initAdmin>>;
// 只替代共享权限门的返回边界，不把这个对象当作真实身份验证结果。
const approved = { id: 'fixture-admin' } as NonNullable<GateResult>;
const kinds = [
  ['apps', '应用'],
  ['games', '游戏'],
  ['articles', '文章'],
  ['works', '作品'],
];
type Item = { kind: string; id: string; title: string };
const items: Item[] = [
  { kind: 'apps', id: 'Alpha', title: 'Alpha 工作台' },
  { kind: 'apps', id: 'Beta', title: 'Literal [v1] <tool>' },
  { kind: 'games', id: 'alpha-game', title: 'Alpha 游戏' },
  { kind: 'articles', id: 'guide', title: '部署指南' },
  { kind: 'works', id: 'poster', title: '海报' },
];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlsFromSource() {
  const match = source.match(/<!-- official-controls:start -->([\s\S]*?)<!-- official-controls:end -->/);
  if (!match) throw new Error('Actual Astro controls are missing');
  const loop =
    /\{\s*groups\.map\(\(g\) =>\s*(?:\(\s*)?<option\s+value=\{g\.id\}>\s*\{g\.label\}\s*<\/option>\s*\)?\s*\)\s*\}/;
  if (!loop.test(match[1])) throw new Error('Actual Astro kind options changed');
  // 只把 Astro 的类型数据插值换成测试数据；不复制或替代待测筛选实现。
  return match[1].replace(
    loop,
    kinds.map(([id, label]) => `<option value="${id}">${label}</option>`).join(''),
  );
}

function mount(data: Item[] = items) {
  document.body.innerHTML = `
    <div data-admin data-section="official">
      <div data-admin-gate></div>
      <div data-admin-body hidden>
        <div data-official>
          ${controlsFromSource()}
          <p id="official-summary" data-official-summary role="status" aria-live="polite">pending</p>
          <p data-official-source-empty hidden>尚无官方内容。</p>
          <div data-official-no-match hidden>
            <p>没有匹配的官方内容</p>
            <button type="button" data-official-clear disabled>清除筛选</button>
          </div>
          <div id="official-list"></div>
        </div>
        <section id="h-off-data"><a href="/fixture-data/">数据文件与页面</a></section>
      </div>
    </div>`;
  const root = document.querySelector<HTMLElement>('[data-official]')!;
  const list = root.querySelector<HTMLElement>('#official-list')!;
  for (const [kind, label] of kinds) {
    const group = document.createElement('section');
    group.dataset.officialGroup = kind;
    group.innerHTML = `<h2>${label}（<span data-official-count>0</span>）</h2><table><tbody></tbody></table>`;
    for (const item of data.filter((entry) => entry.kind === kind)) {
      const row = document.createElement('tr');
      row.dataset.officialRow = '';
      row.dataset.officialTitle = item.title;
      row.dataset.officialId = item.id;
      row.dataset.officialPath = `src/content/${kind}/${item.id}.md`;
      const cell = document.createElement('td');
      const link = document.createElement('a');
      link.href = `/fixture/${kind}/${item.id}/`;
      link.textContent = item.title;
      cell.append(link);
      if (item.id === 'Alpha') {
        const badge = document.createElement('span');
        badge.className = 'badge badge--warn';
        badge.textContent = '待作者补充';
        cell.append(badge);
      }
      row.append(cell);
      group.querySelector('tbody')!.append(row);
    }
    list.append(group);
  }
  return root;
}

function reveal(root: HTMLElement) {
  const admin = root.closest<HTMLElement>('[data-admin]')!;
  admin.querySelector<HTMLElement>('[data-admin-gate]')!.hidden = true;
  admin.querySelector<HTMLElement>('[data-admin-body]')!.hidden = false;
}

function view(root: HTMLElement) {
  return {
    query: root.querySelector<HTMLInputElement>('[data-official-query]')!,
    kind: root.querySelector<HTMLSelectElement>('[data-official-kind]')!,
    clear: root.querySelector<HTMLButtonElement>('[data-official-clear]')!,
    summary: root.querySelector<HTMLElement>('[data-official-summary]')!,
    noMatch: root.querySelector<HTMLElement>('[data-official-no-match]')!,
    empty: root.querySelector<HTMLElement>('[data-official-source-empty]')!,
  };
}
const rows = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-official-row]'));
const visibleIds = (root: HTMLElement) =>
  rows(root)
    .filter((row) => !row.hidden)
    .map((row) => row.dataset.officialId);
function query(root: HTMLElement, value: string) {
  const control = view(root).query;
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}
function kind(root: HTMLElement, value: string) {
  const control = view(root).kind;
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  gate.mockReset();
  document.body.replaceChildren();
  gate.mockImplementation(async () => {
    reveal(document.querySelector<HTMLElement>('[data-official]')!);
    return approved;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('官方列表与真实 Astro 接线', () => {
  it('复用真实工具栏和类型插值，初始禁用，按钮不提交表单', () => {
    const root = mount();
    const controls = view(root);
    expect(controls.query.disabled).toBe(true);
    expect(controls.kind.disabled).toBe(true);
    expect(controls.clear.disabled).toBe(true);
    expect(controls.clear.type).toBe('button');
    expect(controls.query.labels?.[0].textContent).toBe('关键词');
    expect(controls.kind.labels?.[0].textContent).toBe('类型');
    expect(Array.from(controls.kind.options).map((option) => option.value)).toEqual([
      'all',
      'apps',
      'games',
      'articles',
      'works',
    ]);
    expect(controls.query.getAttribute('aria-controls')).toBe('official-list');
  });

  it('真实页保留四组和原始内容链接，只接一条初始化链', () => {
    for (const fragment of [
      'getApps(), getGames(), getArticles(), getWorks()',
      'data-official-group={g.id}',
      'data-official-title={it.title}',
      'data-official-id={it.id}',
      'data-official-path={`${g.dir}/${it.id}.md`}',
      'href={it.href}',
      'href={githubEdit(`${g.dir}/${it.id}.md`)}',
      'href={githubHistory(`${g.dir}/${it.id}.md`)}',
      'it.review &&',
      'dataFiles.map((f)',
      'aria-live="polite"',
      'data-official-source-empty',
      'data-official-no-match',
    ])
      expect(source).toContain(fragment);
    expect(source.match(/void initOfficial\(\)/g)).toHaveLength(1);
    expect(source).not.toContain('void initAdmin()');
  });
});

describe('共享门禁先行，本页不制造授权', () => {
  it('无页面根时不调用共享门禁', async () => {
    await initOfficial();
    expect(gate).not.toHaveBeenCalled();
  });

  it('等待权限时，即使程序化派发事件也不筛选或启用控件', async () => {
    const root = mount();
    const pending = deferred<GateResult>();
    gate.mockReturnValue(pending.promise);
    const ready = initOfficial(root);
    await Promise.resolve();
    query(root, 'no-match');
    kind(root, 'games');
    view(root).clear.dispatchEvent(new Event('click'));
    expect(visibleIds(root)).toEqual(items.map((item) => item.id));
    expect(view(root).summary.textContent).toBe('pending');
    expect(view(root).query.disabled).toBe(true);
    pending.resolve(null);
    await ready;
    expect(view(root).kind.disabled).toBe(true);
    expect(view(root).clear.disabled).toBe(true);
  });

  it('共享门禁拒绝时保持禁用，不把 null 解释为成功', async () => {
    const root = mount();
    gate.mockResolvedValue(null);
    await initOfficial(root);
    query(root, 'Alpha');
    expect(view(root).query.disabled).toBe(true);
    expect(view(root).summary.textContent).toBe('pending');
    expect(visibleIds(root)).toHaveLength(items.length);
  });

  it('共享门禁抛错时保持禁用，不自行重试', async () => {
    const root = mount();
    gate.mockRejectedValue(new Error('fixture gate failure'));
    await expect(initOfficial(root)).resolves.toBeUndefined();
    await initOfficial(root);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(view(root).query.disabled).toBe(true);
  });

  it('只有返回对象但共享界面仍未通过时，不启用筛选', async () => {
    const root = mount();
    gate.mockResolvedValue(approved);
    await initOfficial(root);
    expect(view(root).query.disabled).toBe(true);
    expect(view(root).summary.textContent).toBe('pending');
  });

  it('同一根重复初始化只调用一次权限门、绑定一次输入监听', async () => {
    const root = mount();
    const listener = vi.spyOn(view(root).query, 'addEventListener');
    const first = initOfficial(root);
    expect(initOfficial(root)).toBe(first);
    await first;
    expect(initOfficial(root)).toBe(first);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls.filter(([name]) => name === 'input')).toHaveLength(1);
  });
});

describe('关键词、类型、空态与恢复', () => {
  it('初始数量来自现有行，不把数据文件区域计入', async () => {
    const root = mount();
    await initOfficial(root);
    expect(view(root).summary.textContent).toBe('显示 5 / 5 条');
    expect(view(root).empty.hidden).toBe(true);
    expect(view(root).noMatch.hidden).toBe(true);
    expect(view(root).clear.disabled).toBe(true);
    expect(
      Array.from(root.querySelectorAll('[data-official-count]')).map((node) => node.textContent),
    ).toEqual(['2', '1', '1', '1']);
  });

  it.each<[string, string[]]>([
    ['  ALPHA  ', ['Alpha', 'alpha-game']],
    ['工作台', ['Alpha']],
    ['beta', ['Beta']],
    ['SRC/CONTENT/ARTICLES/GUIDE.MD', ['guide']],
    ['[v1]', ['Beta']],
    ['.*', []],
  ])('把 %s 当字面文本匹配标题、ID 或路径', async (keyword, expected) => {
    const root = mount();
    await initOfficial(root);
    query(root, keyword);
    expect(visibleIds(root)).toEqual(expected);
    expect(rows(root)[0].dataset.officialId).toBe('Alpha');
  });

  it('关键词与类型取交集，两种修改顺序都更新计数和分组', async () => {
    const root = mount();
    await initOfficial(root);
    query(root, 'alpha');
    kind(root, 'games');
    expect(visibleIds(root)).toEqual(['alpha-game']);
    expect(view(root).summary.textContent).toBe('显示 1 / 5 条');
    const groups = Array.from(root.querySelectorAll<HTMLElement>('[data-official-group]'));
    expect(groups.filter((group) => !group.hidden).map((group) => group.dataset.officialGroup)).toEqual([
      'games',
    ]);
    kind(root, 'articles');
    query(root, '指南');
    expect(visibleIds(root)).toEqual(['guide']);
    expect(view(root).summary.textContent).toBe('显示 1 / 5 条');
  });

  it('无匹配时提供清除，恢复原顺序、原链接、徽标和搜索焦点', async () => {
    const root = mount();
    const beforeRows = rows(root);
    const links = Array.from(root.querySelectorAll('a')).map((link) => link.getAttribute('href'));
    const data = document.querySelector('#h-off-data')!.outerHTML;
    await initOfficial(root);
    kind(root, 'games');
    query(root, '不存在');
    expect(view(root).noMatch.hidden).toBe(false);
    expect(view(root).empty.hidden).toBe(true);
    expect(view(root).summary.textContent).toBe('显示 0 / 5 条');
    view(root).noMatch.querySelector<HTMLButtonElement>('[data-official-clear]')!.click();
    expect(view(root).query.value).toBe('');
    expect(view(root).kind.value).toBe('all');
    expect(view(root).noMatch.hidden).toBe(true);
    expect(visibleIds(root)).toEqual(items.map((item) => item.id));
    expect(rows(root)).toEqual(beforeRows);
    expect(Array.from(root.querySelectorAll('a')).map((link) => link.getAttribute('href'))).toEqual(links);
    expect(root.querySelector('.badge--warn')!.textContent).toBe('待作者补充');
    expect(document.querySelector('#h-off-data')!.outerHTML).toBe(data);
    expect(document.activeElement).toBe(view(root).query);
  });

  it('全空格视为无关键词，仍能清除输入框里的空格', async () => {
    const root = mount();
    await initOfficial(root);
    query(root, '   ');
    expect(visibleIds(root)).toHaveLength(5);
    expect(view(root).clear.disabled).toBe(false);
    view(root).clear.click();
    expect(view(root).query.value).toBe('');
    expect(view(root).clear.disabled).toBe(true);
  });

  it('源列表本来为空时，不冒充筛选无匹配或生成行', async () => {
    const root = mount([]);
    await initOfficial(root);
    query(root, 'Alpha');
    expect(view(root).summary.textContent).toBe('显示 0 / 0 条');
    expect(view(root).empty.hidden).toBe(false);
    expect(view(root).noMatch.hidden).toBe(true);
    view(root).clear.click();
    expect(rows(root)).toHaveLength(0);
  });

  it('包含HTML或正则字符的搜索不创建元素，不新增网络请求', async () => {
    const request = vi.fn(() => {
      throw new Error('Unexpected network');
    });
    vi.stubGlobal('fetch', request);
    const root = mount();
    await initOfficial(root);
    query(root, '<img src=x onerror=alert(1)>.*');
    expect(root.querySelector('img')).toBeNull();
    expect(visibleIds(root)).toEqual([]);
    view(root).clear.click();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('根节点归属与过期回调', () => {
  it('异步任务开始前根已移除，不再调用共享门禁', async () => {
    const root = mount();
    const ready = initOfficial(root);
    root.remove();
    await ready;
    expect(gate).not.toHaveBeenCalled();
  });

  it('权限返回前根被替换，不启用旧控件或改动新根', async () => {
    const oldRoot = mount();
    const pending = deferred<GateResult>();
    gate.mockReturnValue(pending.promise);
    const ready = initOfficial(oldRoot);
    await Promise.resolve();
    const next = oldRoot.cloneNode(true) as HTMLElement;
    oldRoot.replaceWith(next);
    const nextBefore = next.outerHTML;
    pending.resolve(approved);
    await ready;
    expect(view(oldRoot).query.disabled).toBe(true);
    expect(next.outerHTML).toBe(nextBefore);
  });

  it('权限等待中控件被替换，不启用已被移走的控件', async () => {
    const root = mount();
    const oldQuery = view(root).query;
    const pending = deferred<GateResult>();
    gate.mockReturnValue(pending.promise);
    const ready = initOfficial(root);
    await Promise.resolve();
    oldQuery.replaceWith(oldQuery.cloneNode(true));
    reveal(root);
    pending.resolve(approved);
    await ready;
    expect(oldQuery.disabled).toBe(true);
    expect(view(root).query.disabled).toBe(true);
  });

  it('共享门重新隐藏正文后，不响应程序化筛选事件', async () => {
    const root = mount();
    await initOfficial(root);
    root.closest<HTMLElement>('[data-admin-body]')!.hidden = true;
    query(root, 'no-match');
    expect(visibleIds(root)).toHaveLength(5);
    expect(view(root).summary.textContent).toBe('显示 5 / 5 条');
  });
});
