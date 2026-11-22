import { initAdmin } from '@/scripts/admin/shell';

const initializations = new WeakMap<HTMLElement, Promise<void>>();

/**
 * 只筛选本页已有的静态行。共享权限门决定能否启用，不增加读取或写入接口。
 * 本模块不修补共享 shell 的生命周期；这里只拒绝操作已移除或被替换的本页根。
 */
export function initOfficial(
  root: HTMLElement | null = document.querySelector<HTMLElement>('[data-official]'),
): Promise<void> {
  if (!root?.isConnected) return Promise.resolve();
  const previous = initializations.get(root);
  if (previous) return previous;

  const admin = root.closest<HTMLElement>('[data-admin][data-section="official"]');
  const body = root.closest<HTMLElement>('[data-admin-body]');
  const gate = admin?.querySelector<HTMLElement>('[data-admin-gate]');
  const query = root.querySelector<HTMLInputElement>('[data-official-query]');
  const kind = root.querySelector<HTMLSelectElement>('[data-official-kind]');
  const clears = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-official-clear]'));
  const summary = root.querySelector<HTMLElement>('[data-official-summary]');
  const sourceEmpty = root.querySelector<HTMLElement>('[data-official-source-empty]');
  const noMatch = root.querySelector<HTMLElement>('[data-official-no-match]');
  if (!admin || !body || !gate || !query || !kind || !clears.length || !summary || !sourceEmpty || !noMatch)
    return Promise.resolve();

  const groups = Array.from(root.querySelectorAll<HTMLElement>('[data-official-group]')).map((node) => ({
    node,
    id: node.dataset.officialGroup ?? '',
    count: node.querySelector<HTMLElement>('[data-official-count]'),
    rows: Array.from(node.querySelectorAll<HTMLTableRowElement>('[data-official-row]')).map((row) => ({
      node: row,
      terms: [row.dataset.officialTitle ?? '', row.dataset.officialId ?? '', row.dataset.officialPath ?? ''],
    })),
  }));
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  let active = false;
  query.disabled = true;
  kind.disabled = true;
  for (const button of clears) button.disabled = true;

  const current = () =>
    root.isConnected &&
    root.ownerDocument.querySelector('[data-admin]') === admin &&
    root.ownerDocument.querySelector('[data-official]') === root &&
    root.closest('[data-admin-body]') === body &&
    admin.contains(body) &&
    root.querySelector('[data-official-query]') === query &&
    root.querySelector('[data-official-kind]') === kind;
  const allowed = () => active && current() && !body.hidden && gate.hidden;

  const render = () => {
    if (!allowed()) return;
    const keyword = query.value.trim().toLowerCase();
    const selected = kind.value;
    let shown = 0;
    for (const group of groups) {
      let count = 0;
      for (const row of group.rows) {
        const matches =
          (selected === 'all' || selected === group.id) &&
          row.terms.some((term) => term.toLowerCase().includes(keyword));
        row.node.hidden = !matches;
        if (matches) count++;
      }
      group.node.hidden = count === 0;
      if (group.count) group.count.textContent = String(count);
      shown += count;
    }
    summary.textContent = `显示 ${shown} / ${total} 条`;
    sourceEmpty.hidden = total !== 0;
    noMatch.hidden = total === 0 || shown !== 0;
    for (const button of clears) button.disabled = query.value === '' && selected === 'all';
  };
  const clear = () => {
    if (!allowed()) return;
    query.value = '';
    kind.value = 'all';
    render();
    query.focus();
  };
  query.addEventListener('input', render);
  kind.addEventListener('change', render);
  for (const button of clears) button.addEventListener('click', clear);

  const ready = Promise.resolve().then(async () => {
    if (!current()) return;
    try {
      const profile = await initAdmin();
      if (!profile || !current() || body.hidden || !gate.hidden) return;
      active = true;
      query.disabled = false;
      kind.disabled = false;
      render();
    } catch {
      // 共享权限门保留原来的错误呈现；本页控件继续禁用，不另发重试或请求。
      active = false;
      if (current()) {
        query.disabled = true;
        kind.disabled = true;
        for (const button of clears) button.disabled = true;
      }
    }
  });
  initializations.set(root, ready);
  return ready;
}
