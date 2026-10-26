/** /admin/data/：导出 UGC（JSON / CSV，不含邮箱）、导出 / 导入站点设置。 */
import { EXPORT_COLUMNS, type ExportTable } from '@/lib/data';
import { toCsv } from '@/lib/csv';
import { parseSettingsImport, settingsExport, type ImportResult } from '@/lib/settings';
import { clearSiteSettingsCache } from '../site-settings';
import { toast } from '../community/ui';
import { adminRepo, download, errorText, h, initAdmin, setStatusText, stamp } from './shell';

const exportStatus = document.querySelector<HTMLElement>('[data-export-status]');
const TABLES: [ExportTable, string][] = [
  ['forum_threads', '主题'],
  ['forum_replies', '回复'],
  ['comments', '评论'],
  ['profiles', '用户'],
];

async function exportTable(t: ExportTable, label: string) {
  return adminRepo().exportRows(t, (n) => setStatusText(exportStatus, `正在导出${label}… ${n} 条`));
}

async function guard(btn: HTMLButtonElement, fn: () => Promise<void>) {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    setStatusText(exportStatus, errorText(e, '导出失败'), 'error');
  } finally {
    btn.disabled = false;
  }
}

document.querySelector<HTMLButtonElement>('[data-export-json]')!.addEventListener('click', (e) =>
  guard(e.currentTarget as HTMLButtonElement, async () => {
    const out: Record<string, unknown> = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: location.origin,
    };
    for (const [t, label] of TABLES) out[t] = await exportTable(t, label);
    download(`azsou-ugc-${stamp()}.json`, JSON.stringify(out, null, 2), 'application/octet-stream');
    const counts = TABLES.map(([t, label]) => `${label} ${(out[t] as unknown[]).length}`).join('，');
    setStatusText(exportStatus, `已导出：${counts}。`);
  }),
);
document.querySelectorAll<HTMLButtonElement>('[data-export-csv]').forEach((b) =>
  b.addEventListener('click', () =>
    guard(b, async () => {
      const t = b.dataset.exportCsv as ExportTable;
      const label = TABLES.find((x) => x[0] === t)![1];
      const rows = await exportTable(t, label);
      download(
        `azsou-${t}-${stamp()}.csv`,
        toCsv(rows, EXPORT_COLUMNS[t].split(',')),
        'text/csv;charset=utf-8',
      );
      setStatusText(exportStatus, `已导出${label} ${rows.length} 条。`);
    }),
  ),
);

document.querySelector<HTMLButtonElement>('[data-export-settings]')!.addEventListener('click', async () => {
  try {
    const rows = await adminRepo().settings();
    download(
      `azsou-settings-${stamp()}.json`,
      JSON.stringify(settingsExport(rows), null, 2),
      'application/json',
    );
  } catch (e) {
    toast(errorText(e, '导出失败'), 'error');
  }
});

// ---------------------------------------------------------------- 导入 -----
const form = document.querySelector<HTMLFormElement>('[data-import-form]')!;
const fileInput = form.querySelector<HTMLInputElement>('input[type="file"]')!;
const preview = form.querySelector<HTMLElement>('[data-import-preview]')!;
const list = form.querySelector<HTMLElement>('[data-import-list]')!;
const status = form.querySelector<HTMLElement>('[data-import-status]')!;
const submit = form.querySelector<HTMLButtonElement>('[data-import-submit]')!;
let parsed: ImportResult | null = null;

const LABEL: Record<string, string> = { announcement: '站点公告', forum: '论坛分类', registration: '注册' };

fileInput.addEventListener('change', async () => {
  parsed = null;
  submit.disabled = true;
  preview.hidden = true;
  status.className = 'form-status';
  status.textContent = '';
  const f = fileInput.files?.[0];
  if (!f) return;
  if (f.size > 64 * 1024) {
    status.textContent = '文件太大（设置文件应小于 64KB）。';
    status.className = 'form-status notice notice--error';
    return;
  }
  const r = parseSettingsImport(await f.text());
  if (!r.ok) {
    status.textContent = r.errors.join('；');
    status.className = 'form-status notice notice--error';
    return;
  }
  parsed = r;
  list.replaceChildren(
    ...r.settings.map((s) =>
      h(
        'li',
        { class: 'list-row' },
        h(
          'span',
          { class: 'list-row__main' },
          h('span', { class: 'list-row__title', text: LABEL[s.slug] ?? s.slug }),
          h('span', { class: 'list-row__sub', text: JSON.stringify(s.data).slice(0, 160) }),
        ),
      ),
    ),
  );
  preview.hidden = false;
  submit.disabled = false;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!parsed?.ok) return;
  submit.disabled = true;
  try {
    for (const s of parsed.settings) await adminRepo().saveSetting(s.slug, { ...s.data }, s.published);
    clearSiteSettingsCache();
    status.textContent = `已导入 ${parsed.settings.length} 项设置。`;
    status.className = 'form-status';
    toast('设置已导入。');
    form.reset();
    preview.hidden = true;
    parsed = null;
  } catch (err) {
    status.textContent = errorText(err, '导入失败');
    status.className = 'form-status notice notice--error';
    submit.disabled = false;
  }
});

void initAdmin();
