/**
 * 站点设置（site_content kind='setting'）：结构、默认值、校验与导入。
 * 读：任何人（已发布的设置行，RLS content_read）；写：只有管理员（RLS content_admin_*）。
 * 页面拿不到设置（网络失败 / 旧库）时一律按默认值工作。
 */
import forumData from '@/data/forum.json';

export interface AnnouncementSetting {
  enabled: boolean;
  text: string;
  level: 'info' | 'warning';
  /** 可选链接（站内路径或 https 地址） */
  link: string;
  linkText: string;
}

export interface ForumCategorySetting {
  id: string;
  enabled: boolean;
  order: number;
}
export interface ForumSetting {
  categories: ForumCategorySetting[];
}

export interface RegistrationSetting {
  open: boolean;
  /** 关闭注册时显示给访客的说明 */
  message: string;
}

export interface SiteSettings {
  announcement: AnnouncementSetting;
  forum: ForumSetting;
  registration: RegistrationSetting;
}
export type SettingSlug = keyof SiteSettings;
export const SETTING_SLUGS: SettingSlug[] = ['announcement', 'forum', 'registration'];

export const CATEGORY_LIST = forumData.categories.map((c) => ({ id: c.id, name: c.name }));

export const DEFAULT_SETTINGS: SiteSettings = {
  announcement: { enabled: false, text: '', level: 'info', link: '', linkText: '' },
  forum: { categories: CATEGORY_LIST.map((c, i) => ({ id: c.id, enabled: true, order: i })) },
  registration: { open: true, message: '' },
};

export const LIMITS = { announcement: 200, linkText: 20, registrationMessage: 200 } as const;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** 链接只允许站内路径或 http(s) */
export function safeLink(v: unknown): string {
  const s = text(v, 300);
  if (!s) return '';
  if (/^\/(?!\/)/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeAnnouncement(v: unknown): AnnouncementSetting {
  const o = obj(v);
  const t = text(o.text, LIMITS.announcement);
  return {
    enabled: bool(o.enabled, false) && !!t,
    text: t,
    level: o.level === 'warning' ? 'warning' : 'info',
    link: safeLink(o.link),
    linkText: text(o.linkText, LIMITS.linkText),
  };
}

export function normalizeForum(v: unknown): ForumSetting {
  const o = obj(v);
  const given = Array.isArray(o.categories) ? o.categories.map(obj) : [];
  const known = new Set(CATEGORY_LIST.map((c) => c.id));
  const seen = new Set<string>();
  const list: ForumCategorySetting[] = [];
  for (const c of given) {
    const id = typeof c.id === 'string' ? c.id : '';
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      enabled: bool(c.enabled, true),
      order: Number.isFinite(c.order) ? Number(c.order) : list.length,
    });
  }
  // 新增分类（设置里还没有）排在最后，默认启用
  for (const c of CATEGORY_LIST)
    if (!seen.has(c.id)) list.push({ id: c.id, enabled: true, order: list.length + 1000 });
  list.sort((a, b) => a.order - b.order);
  return { categories: list.map((c, i) => ({ ...c, order: i })) };
}

export function normalizeRegistration(v: unknown): RegistrationSetting {
  const o = obj(v);
  return { open: bool(o.open, true), message: text(o.message, LIMITS.registrationMessage) };
}

export const NORMALIZE: { [K in SettingSlug]: (v: unknown) => SiteSettings[K] } = {
  announcement: normalizeAnnouncement,
  forum: normalizeForum,
  registration: normalizeRegistration,
};

/** 把 site_content 设置行合并成完整设置（缺的用默认值） */
export function mergeSettings(rows: { slug: string; data: unknown; published?: boolean }[]): SiteSettings {
  const out: SiteSettings = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (r.published === false || !SETTING_SLUGS.includes(r.slug as SettingSlug)) continue;
    const slug = r.slug as SettingSlug;
    (out as unknown as Record<string, unknown>)[slug] = NORMALIZE[slug](r.data);
  }
  return out;
}

/** 已启用的分类，按设置顺序 */
export function enabledCategories(s: ForumSetting): string[] {
  return s.categories.filter((c) => c.enabled).map((c) => c.id);
}

// ---------------------------------------------------------------- import ---
export interface ImportResult {
  ok: boolean;
  settings: { slug: SettingSlug; data: SiteSettings[SettingSlug]; published: boolean }[];
  errors: string[];
}

/**
 * 导入 JSON：支持本站导出的格式 {"version":1,"settings":[{slug,data,published}]}，
 * 也支持简写 {"announcement":{…},"registration":{…}}。未知键报错；数据按 normalize 清洗。
 */
export function parseSettingsImport(raw: string): ImportResult {
  const errors: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, settings: [], errors: ['不是有效的 JSON'] };
  }
  const root = obj(json);
  let entries: { slug: unknown; data: unknown; published?: unknown }[];
  if (Array.isArray(root.settings)) entries = root.settings.map(obj) as typeof entries;
  else if (Object.keys(root).length) entries = Object.entries(root).map(([slug, data]) => ({ slug, data }));
  else return { ok: false, settings: [], errors: ['JSON 里没有设置项'] };
  if (entries.length > 20) return { ok: false, settings: [], errors: ['设置项太多（最多 20 项）'] };
  const settings: ImportResult['settings'] = [];
  for (const e of entries) {
    const slug = typeof e.slug === 'string' ? e.slug : '';
    if (!SETTING_SLUGS.includes(slug as SettingSlug)) {
      if (slug !== 'version') errors.push(`未知的设置项「${slug || '(空)'}」`);
      continue;
    }
    if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) {
      errors.push(`「${slug}」的 data 必须是对象`);
      continue;
    }
    settings.push({
      slug: slug as SettingSlug,
      data: NORMALIZE[slug as SettingSlug](e.data),
      published: e.published !== false,
    });
  }
  if (!settings.length && !errors.length) errors.push('JSON 里没有可导入的设置项');
  return { ok: errors.length === 0 && settings.length > 0, settings, errors };
}

export function settingsExport(s: { slug: string; data: unknown; published: boolean }[]) {
  return { version: 1, exportedAt: new Date().toISOString(), settings: s };
}

// ---------------------------------------------------------- rate limits ---
/**
 * 数据库里的限流（0004 az_rate_limit 调用处）。只用于后台展示；
 * tests/unit/settings.test.ts 会从迁移 SQL 里解析出来逐项比对，保证不漂移。
 */
export const RATE_LIMITS = [
  { action: 'thread', label: '发主题', max: 3, per: '10 minutes' },
  { action: 'thread_day', label: '发主题（每日）', max: 20, per: '1 day' },
  { action: 'reply', label: '回帖', max: 6, per: '1 minute' },
  { action: 'reply_hour', label: '回帖（每小时）', max: 60, per: '1 hour' },
  { action: 'comment', label: '评论', max: 5, per: '1 minute' },
  { action: 'comment_hour', label: '评论（每小时）', max: 60, per: '1 hour' },
  { action: 'like', label: '点赞', max: 30, per: '1 minute' },
  { action: 'bookmark', label: '收藏', max: 30, per: '1 minute' },
  { action: 'report', label: '举报', max: 10, per: '1 hour' },
  { action: 'profile_update', label: '改昵称', max: 10, per: '1 hour' },
] as const;

export const PER_LABEL: Record<string, string> = {
  '1 minute': '每分钟',
  '10 minutes': '每 10 分钟',
  '1 hour': '每小时',
  '1 day': '每天',
};

/** 注册相关的限制（不在数据库里，来自 Turnstile 与 Supabase Auth 配置）——后台只读展示 */
export const SIGNUP_LIMITS = [
  {
    label: '注册 / 找回密码 / 重发确认邮件',
    value: '每次都需通过 Cloudflare Turnstile 人机验证（/api/auth/*）',
  },
  { label: '注册票据', value: '服务端签发，15 分钟有效（启用 0007 注册钩子后强制）' },
  {
    label: '邮件发送频率',
    value: '由 Supabase Auth → Rate Limits 配置（默认每小时 2 封，可在 Dashboard 调整）',
  },
] as const;
