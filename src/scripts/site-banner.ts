/**
 * 所有公开页面：站点公告条（固定在底部、不推动页面布局 → 不产生 CLS）与论坛分类顺序。
 * 页面空闲后才加载（见 Base.astro）；后台页面不显示公告条。
 */
import type { AnnouncementSetting } from '@/lib/settings';
import { loadSiteSettings } from './site-settings';

const DISMISS = 'az-banner-dismissed';
/** 公告内容的指纹：内容变了，之前关闭过的访客会再次看到 */
export const bannerKey = (a: AnnouncementSetting) => `${a.level}|${a.text}|${a.link}`;

function renderBanner(a: AnnouncementSetting) {
  if (!a.enabled || !a.text || location.pathname.startsWith('/admin/')) return;
  try {
    if (localStorage.getItem(DISMISS) === bannerKey(a)) return;
  } catch {
    /* 忽略 */
  }
  const box = document.createElement('aside');
  box.className = `site-banner glass site-banner--${a.level}`;
  box.setAttribute('aria-label', '站点公告');
  box.dataset.siteBanner = '';
  const p = document.createElement('p');
  p.textContent = a.text;
  if (a.link) {
    const link = document.createElement('a');
    link.href = a.link;
    link.textContent = a.linkText || '了解更多';
    if (/^https?:/.test(a.link) && new URL(a.link).origin !== location.origin) link.rel = 'noopener';
    p.append(' ', link);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'site-banner__close';
  close.setAttribute('aria-label', '关闭公告');
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  close.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS, bannerKey(a));
    } catch {
      /* 忽略 */
    }
    box.remove();
  });
  box.append(p, close);
  document.body.append(box);
}

/** 论坛首页分类卡片：按设置排序（停用的分类只是不能发新帖，已有主题照常可读，卡片保留） */
function orderForum(order: string[]) {
  const grid = document.querySelector<HTMLElement>('[data-forum-cats]');
  if (!grid) return;
  const cards = new Map(
    [...grid.querySelectorAll<HTMLElement>('[data-cat]')].map((c) => [c.dataset.cat!, c]),
  );
  for (const id of order) {
    const card = cards.get(id);
    if (card) grid.append(card);
  }
}

export async function initSiteBanner() {
  const s = await loadSiteSettings();
  renderBanner(s.announcement);
  orderForum(s.forum.categories.map((c) => c.id));
}
