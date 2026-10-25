/** 主题偏好（T7.5）：system 跟随系统（默认）、light、dark。逻辑与 Base.astro 的首帧内联脚本一致。 */
export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_KEY = 'az-theme';
export const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<ThemePref, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const META = { light: '#f5f5f7', dark: '#000000' } as const;

export const isThemePref = (v: unknown): v is ThemePref => v === 'system' || v === 'light' || v === 'dark';
export const nextTheme = (t: ThemePref): ThemePref => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % 3];

export function readTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemePref {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemePref(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function safeStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** 写到 <html>（data-theme / data-theme-pref）与 theme-color；persist=true 时存起来（system 删掉键） */
export function applyTheme(t: ThemePref, persist: boolean, doc: Document = document) {
  const root = doc.documentElement;
  root.setAttribute('data-theme-pref', t);
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  for (const m of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = m.getAttribute('media') ?? '';
    m.content = t === 'system' ? (media.includes('dark') ? META.dark : META.light) : META[t];
  }
  if (!persist) return;
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* 隐私模式等：只对当前页面生效 */
  }
}

/** 当前实际生效的明暗（给 Turnstile 之类需要明确主题的第三方组件） */
export function effectiveTheme(doc: Document = document): 'light' | 'dark' {
  const t = doc.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
