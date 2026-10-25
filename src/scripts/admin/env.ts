/** 后台顶栏的环境标签（T9.16）：生产 / 预览 / 本地，避免在生产库上误操作。只看域名，不发请求。 */
export function envOf(host: string): { label: string; kind: 'prod' | 'preview' | 'local' } {
  if (/^(www\.)?azsou\.com$/.test(host)) return { label: '生产', kind: 'prod' };
  if (/\.vercel\.app$/.test(host)) return { label: '预览', kind: 'preview' };
  return { label: '本地', kind: 'local' };
}

export function initAdminEnv() {
  const el = document.querySelector<HTMLElement>('[data-admin-env]');
  if (!el) return;
  const e = envOf(location.hostname);
  el.textContent = e.label;
  el.dataset.env = e.kind;
}
