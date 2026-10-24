/**
 * 应用详情页 island（空闲时加载）：截图轮播与灯箱、真实评分 / 下载数、评价区。
 * 数据库不可达时只是保持「—」/「暂无评分」，不影响页面其余部分。
 */
import { getAppStore } from '@/lib/data/app-store';
import { PLATFORM_LABEL, formatCount, type PlatformOs } from '@/lib/app-store';
import { paintRating } from './detail-paint';

const page = document.querySelector<HTMLElement>('[data-app-page]');

// ------------------------------------------------------------- 截图 -------
function initShots(root: HTMLElement) {
  const track = root.querySelector<HTMLElement>('[data-shots-track]')!;
  const shots = [...root.querySelectorAll<HTMLButtonElement>('[data-shot]')];
  const step = (dir: number) => {
    const first = track.querySelector<HTMLElement>('li');
    const w = (first?.getBoundingClientRect().width ?? track.clientWidth) + 16;
    track.scrollBy({
      left: dir * w,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  root.querySelector('[data-shots-prev]')?.addEventListener('click', () => step(-1));
  root.querySelector('[data-shots-next]')?.addEventListener('click', () => step(1));

  const dlg = root.querySelector<HTMLDialogElement>('[data-lightbox]')!;
  // 灯箱里的 <img> 第一次打开时才创建（页面上不留空的图片元素）
  let img: HTMLImageElement | null = null;
  const cap = dlg.querySelector<HTMLElement>('[data-lightbox-caption]')!;
  const count = dlg.querySelector<HTMLElement>('[data-lightbox-count]')!;
  let cur = 0;
  let opener: HTMLElement | null = null;
  const show = (i: number) => {
    cur = (i + shots.length) % shots.length;
    const b = shots[cur];
    const inner = b.querySelector('img')!;
    if (!img) {
      img = document.createElement('img');
      img.dataset.lightboxImg = '';
      dlg.querySelector('figure')!.prepend(img);
    }
    img.src = b.dataset.src!;
    img.width = Number(b.dataset.w);
    img.height = Number(b.dataset.h);
    img.alt = inner.alt;
    cap.textContent = inner.alt;
    count.textContent = `${cur + 1} / ${shots.length}`;
  };
  shots.forEach((b, i) =>
    b.addEventListener('click', () => {
      opener = b;
      show(i);
      dlg.showModal();
    }),
  );
  dlg.querySelector('[data-lightbox-prev]')!.addEventListener('click', () => show(cur - 1));
  dlg.querySelector('[data-lightbox-next]')!.addEventListener('click', () => show(cur + 1));
  dlg.querySelector('[data-lightbox-close]')!.addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(cur - 1);
    if (e.key === 'ArrowRight') show(cur + 1);
  });
  // 点在图片外的遮罩上关闭
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', () => opener?.focus());
  if (shots.length < 2)
    dlg
      .querySelectorAll<HTMLElement>('[data-lightbox-prev],[data-lightbox-next]')
      .forEach((b) => (b.hidden = true));
}

// ------------------------------------------------------------ 统计 --------
async function initStats(root: HTMLElement, app: string) {
  const s = await getAppStore().appStats(app);
  paintRating(root, s.reviews);
  const total = Object.values(s.downloads).reduce((a, b) => a + (b ?? 0), 0);
  const t = root.querySelector<HTMLElement>('[data-downloads-total]');
  if (t) t.textContent = formatCount(total);
  const detail = root.querySelector<HTMLElement>('[data-downloads-detail]');
  if (detail) {
    const parts = (Object.entries(s.downloads) as [PlatformOs, number][])
      .filter(([, n]) => n > 0)
      .map(([os, n]) => `${PLATFORM_LABEL[os]} ${formatCount(n)}`);
    detail.textContent = total > 0 ? `共 ${formatCount(total)} 次（${parts.join('，')}）` : '0 次';
  }
  return s.reviews;
}

if (page) {
  const app = page.dataset.app!;
  const shots = page.querySelector<HTMLElement>('[data-shots]');
  if (shots) initShots(shots);
  const stats = initStats(page, app).catch(() => null);
  const reviews = page.querySelector<HTMLElement>('[data-reviews]');
  if (reviews) void import('./reviews').then((m) => m.initReviews(reviews, stats));
}
