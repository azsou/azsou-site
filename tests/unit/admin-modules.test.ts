import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from '@/lib/admin-nav';
import { migrationOf, objectFromPath } from '@/lib/data/schema-map';
import { ADMIN_READ_MODULES, SHELL_ENDPOINTS } from '../e2e/admin-modules';

/**
 * A15 八模块清单与真实后台对账（站长 2026-10-27 21:06：先纠正清单，A15 在真实 8 模块读取通过前保持打开）。
 * 交接文档原文：「概览、内容、用户、举报、留言、友链、订阅、审计共 8 个模块」。
 */
const HANDOFF = ['概览', '内容', '用户', '举报', '留言', '友链', '订阅', '审计'];

describe('A15 八模块清单', () => {
  it('与交接文档逐项一致（顺序、数量）', () => {
    expect(ADMIN_READ_MODULES.map((m) => m.handoff)).toEqual(HANDOFF);
  });

  it('每个模块都是真实后台侧栏里的页面：id / 文字 / 路径与 admin-nav.ts 一致', () => {
    for (const m of ADMIN_READ_MODULES) {
      const s = ADMIN_SECTIONS.find((x) => x.id === m.nav);
      expect(s, `${m.id}：侧栏里没有 ${m.nav}`).toBeTruthy();
      expect(s!.label).toBe(m.label);
      expect(s!.path).toBe(m.path);
    }
  });

  it('不读 0002+ 对象的后台页面不在清单里（设置 / 导入导出 / 权限矩阵 / 官方内容）', () => {
    const navs = ADMIN_READ_MODULES.map((m) => m.nav as string);
    for (const id of ['settings', 'data', 'permissions', 'official']) expect(navs).not.toContain(id);
    // 侧栏其余页面 = 8 模块 + 上面 4 个，没有遗漏的读库页面
    expect(ADMIN_SECTIONS.map((s) => s.id).sort()).toEqual(
      [...navs, 'settings', 'data', 'permissions', 'official'].sort(),
    );
  });

  it('错误条里的迁移编号 = 模块主数据对象的创建迁移（schema-map.ts，单测另行对账迁移文件）', () => {
    for (const m of ADMIN_READ_MODULES) {
      expect(migrationOf(objectFromPath(m.endpoints[0])), m.id).toBe(m.migration);
      // 其余端点要么在 schema-map 里有编号，要么是 V72 基线就有的表（forum_threads）
      for (const e of m.endpoints.slice(1)) {
        const o = objectFromPath(e);
        expect(migrationOf(o) ?? (o === 'forum_threads' ? '0001' : null), `${m.id} ${e}`).not.toBeNull();
      }
    }
    for (const e of SHELL_ENDPOINTS) expect(migrationOf(objectFromPath(e)), e).not.toBeNull();
  });
});
