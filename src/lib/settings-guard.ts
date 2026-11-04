/**
 * 后台站点设置的写保护（A16 / T092 / T095）：纯逻辑，单元测试覆盖。
 *
 *  - 只有成功读到数据库里的真实设置（phase = loaded）才允许保存；读取失败 / 超时 / 还在加载时一律不发写请求，
 *    也不把默认值填进表单冒充真实配置。
 *  - 重新加载的响应回来时：没改过的表单直接更新；改过（dirty）的表单保留用户输入——
 *    数据库值与上次加载的一致就静默保留，不一致就标记冲突，由用户选择「用数据库的值」或「保留我的修改」。
 *  - 过期响应（不是最近一次发出的请求）直接丢弃。
 */
import { SETTING_SLUGS, type SettingSlug, type SiteSettings } from './settings';

export type SettingsPhase = 'loading' | 'loaded' | 'error';

/** 稳定序列化后比较（键顺序无关） */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export type ReconcileAction = 'apply' | 'keep' | 'conflict';

/**
 * 重新加载的结果怎么落到每个表单：
 *  - 没改过 → apply（显示数据库值）
 *  - 改过，数据库值与上次加载的基线相同 → keep（保留输入，无冲突）
 *  - 改过，数据库值已变化 → conflict（保留输入并提示冲突）
 */
export function reconcile(
  baseline: SiteSettings | null,
  incoming: SiteSettings,
  dirty: ReadonlySet<SettingSlug>,
): Record<SettingSlug, ReconcileAction> {
  const out = {} as Record<SettingSlug, ReconcileAction>;
  for (const slug of SETTING_SLUGS) {
    if (!dirty.has(slug) || !baseline) out[slug] = 'apply';
    else out[slug] = sameValue(baseline[slug], incoming[slug]) ? 'keep' : 'conflict';
  }
  return out;
}

/** 能否保存：必须已从数据库成功加载，且该表单没有未处理的冲突 */
export function canSave(phase: SettingsPhase, conflicts: ReadonlySet<SettingSlug>, slug: SettingSlug) {
  if (phase !== 'loaded') return { ok: false as const, reason: 'not-loaded' as const };
  if (conflicts.has(slug)) return { ok: false as const, reason: 'conflict' as const };
  return { ok: true as const };
}

/** 请求序号：只有最近一次发出的请求的结果才生效 */
export function createSeq() {
  let n = 0;
  return {
    next: () => ++n,
    isCurrent: (id: number) => id === n,
  };
}
