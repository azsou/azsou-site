/**
 * 下载中转页：点击「继续前往」时先记一次下载（最多等 1.5 秒，失败也照常跳转），再离开本站。
 * 计数的去重、限流、爬虫过滤都在数据库（app_count_download）。
 */
import { getAppStore } from '@/lib/data/app-store';
import { formatCount, type PlatformOs } from '@/lib/app-store';

const root = document.querySelector<HTMLElement>('[data-go-page]');
const link = document.querySelector<HTMLAnchorElement>('[data-go]');
const status = document.querySelector<HTMLElement>('[data-go-status]');
const countEl = document.querySelector<HTMLElement>('[data-go-count]');

if (root && link) {
  const app = root.dataset.app!;
  const os = root.dataset.os as PlatformOs;
  const api = getAppStore();

  api
    .appStats(app)
    .then((s) => {
      if (countEl) countEl.textContent = `${formatCount(s.downloads[os] ?? 0)} 次`;
    })
    .catch(() => {
      if (countEl) countEl.textContent = '暂时无法读取';
    });

  let going = false;
  link.addEventListener('click', async (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // 新标签页打开：不拦截
    e.preventDefault();
    if (going) return;
    going = true;
    link.setAttribute('aria-busy', 'true');
    if (status) status.textContent = '正在前往…';
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500));
    const n = await Promise.race([api.countDownload(app, os).catch(() => null), timeout]);
    if (typeof n === 'number' && countEl) countEl.textContent = `${formatCount(n)} 次`;
    root.dataset.counted = typeof n === 'number' ? 'yes' : 'no';
    location.assign(link.href);
  });

  root.dataset.ready = 'yes';

  document.querySelector('[data-copy-sha]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const sha = document.querySelector('[data-sha]')?.textContent?.trim() ?? '';
    try {
      await navigator.clipboard.writeText(sha);
      btn.textContent = '已复制';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('[data-sha]')!);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      btn.textContent = '已选中，按 Ctrl+C 复制';
    }
  });
}
