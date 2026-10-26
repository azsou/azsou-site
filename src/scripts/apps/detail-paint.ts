/** 详情页头部的评分格（详情页与评价区共用） */
import type { ReviewStats } from '@/lib/data/app-store';
import { formatRating, ratingLabel } from '@/lib/app-store';

export function paintRating(root: ParentNode, r: ReviewStats) {
  const v = root.querySelector<HTMLElement>('[data-rating-value]');
  const sub = root.querySelector<HTMLElement>('[data-rating-sub]');
  if (v && sub) {
    const cell = v.closest<HTMLElement>('[data-stat-rating]');
    if (cell) cell.hidden = !(r.reviews > 0 && r.average !== null);
    if (r.reviews > 0 && r.average !== null) {
      v.textContent = formatRating(r.average);
      sub.textContent = `${r.reviews} 条评价`;
      v.title = ratingLabel(r.average, r.reviews);
    } else {
      v.textContent = '—';
      sub.textContent = '暂无评分';
    }
  }
}
