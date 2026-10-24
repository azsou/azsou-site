/**
 * 公开页面读取站点设置（site_content kind=setting，匿名可读已发布行）。
 * 不引数据层（首屏 JS 预算）；sessionStorage 缓存 5 分钟；失败时返回默认设置。
 */
import { mergeSettings, type SiteSettings } from '@/lib/settings';
import { supabaseConfig } from '@/lib/supabase-config';

const CACHE = 'az-site-settings-v1';
const TTL = 5 * 60_000;
let pending: Promise<SiteSettings> | null = null;

export function clearSiteSettingsCache() {
  pending = null;
  try {
    sessionStorage.removeItem(CACHE);
  } catch {
    /* 隐私模式 */
  }
}

export function loadSiteSettings(opts: { fresh?: boolean; timeoutMs?: number } = {}): Promise<SiteSettings> {
  if (opts.fresh) clearSiteSettingsCache();
  if (pending) return pending;
  pending = (async () => {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE) ?? 'null');
      if (c && Date.now() - c.at < TTL && Array.isArray(c.rows)) return mergeSettings(c.rows);
    } catch {
      /* 忽略 */
    }
    const { url, key } = supabaseConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(
        `${url}/rest/v1/site_content?kind=eq.setting&published=eq.true&select=slug,data,published,updated_at`,
        {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
          signal: ctrl.signal,
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('bad');
      try {
        sessionStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), rows }));
      } catch {
        /* 忽略 */
      }
      return mergeSettings(rows);
    } catch {
      return mergeSettings([]);
    } finally {
      clearTimeout(timer);
    }
  })();
  return pending;
}
