/**
 * V72 使用 hash 路由（#/article/slug、#project …）。v2 改为真实 URL，
 * 这里把旧 hash 映射为新路径；首页加载时执行一次 location.replace。
 * 返回 null 表示不需要跳转（例如普通页内锚点 #main）。
 */
const SIMPLE: Record<string, string> = {
  '': '/',
  home: '/',
  apps: '/apps/',
  games: '/games/',
  articles: '/articles/',
  works: '/works/',
  archive: '/archive/',
  forum: '/forum/',
  project: '/apps/fablemotion/',
  login: '/login/',
  register: '/register/',
  'forgot-password': '/reset-password/',
  admin: '/admin/',
  user: '/settings/',
  search: '/search/',
};

const SLUG = /^[a-z0-9-]+$/i;
const UUID = /^[0-9a-f-]{36}$/i;

export function mapLegacyHash(hash: string): string | null {
  if (!hash || hash === '#') return null;
  const raw = hash.replace(/^#/, '');
  const hadSlash = raw.startsWith('/');
  let parts: string[];
  try {
    parts = raw.replace(/^\/+/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [view = '', id, ...rest] = parts;
  if (rest.length > 1) return null;

  if (id) {
    if (!SLUG.test(id) && view !== 'forum' && view !== 'user') return null;
    switch (view) {
      case 'article':
        return `/articles/${id}/`;
      case 'game':
        return `/games/${id}/`;
      case 'work':
        return `/works/${id}/`;
      case 'app':
      case 'apps':
        return `/apps/${id}/`;
      case 'forum':
        if (/^t-[a-z0-9-]+$/.test(id)) return `/forum/t/${id}/`;
        if (UUID.test(id)) return `/forum/thread/?id=${id}`;
        if (/^(announce|product|tech|meta)$/.test(id)) return `/forum/${id}/`;
        return '/forum/';
      case 'user':
        return UUID.test(id) ? `/u/?id=${id}` : null;
      case 'admin':
        return '/admin/';
      default:
        return null;
    }
  }
  // 无斜杠形式（#project、#home）只认已知视图，避免吞掉页内锚点
  if (!hadSlash && !(view in SIMPLE && view !== '')) return null;
  return SIMPLE[view] ?? null;
}
