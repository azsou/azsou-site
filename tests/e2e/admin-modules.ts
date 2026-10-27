/**
 * A15 / T091 的「8 个核心后台模块」——唯一清单（admin-read.spec、admin-faults.spec、tests/unit/admin-modules.test.ts 共用）。
 *
 * 来源与核对：
 *  - 交接文档 docs/audits/2026-10-27-hark-handoff.md（分支 docs/hark-handoff-2026-10-27）：
 *    「概览、内容、用户、举报、留言、友链、订阅、审计共 8 个模块」读取失败（截图 18/19/21/24–28），验收用例 T091。
 *  - 真实后台：src/lib/admin-nav.ts 的 ADMIN_SECTIONS（nav = 侧栏 id，label = 侧栏文字），单测逐项核对。
 *  - endpoints = 健康库上该模块实际发出的数据请求（admin-faults.spec 基线用例在真实 PostgREST 上记录并断言相等），
 *    不含每个后台页面都会发的外壳请求 SHELL_ENDPOINTS（举报角标、通知数）和 profiles / site_content。
 *  - migration = 生产现状库（shim + 0001）打开该模块时错误条里应写的迁移编号：模块主数据对象的创建迁移（schema-map.ts）。
 *
 * 不在 8 模块里的后台页面（交接文档没有把它们列为读取失败，且不依赖 0002+ 的对象或根本不读库）：
 *   站点设置 /admin/settings/（site_content，V72 已有；A16 / T092 / T095 另测）、导入导出 /admin/data/（按需导出）、
 *   权限矩阵 /admin/permissions/（静态）、官方内容 /admin/official/（构建期 Git 清单），以及用户详情 /admin/users/view/（从用户列表进入）。
 */
export const SHELL_ENDPOINTS = ['reports', 'rpc/unread_notification_count'] as const;

export const ADMIN_READ_MODULES = [
  {
    id: 'overview',
    handoff: '概览',
    nav: 'dashboard',
    label: '概览',
    path: '/admin/',
    migration: '0009',
    endpoints: ['rpc/admin_stats', 'rpc/mod_lift_expired_bans'],
    ready: '[data-stats] .stat',
  },
  {
    id: 'content',
    handoff: '内容',
    nav: 'content',
    label: '内容管理',
    path: '/admin/content/',
    migration: '0009',
    // mod_workflow_tick（0017）：打开内容页时补偿结算到期的定时发布；mod_list_content 的排序参数也是 0017（缺时降级）
    endpoints: ['rpc/mod_list_content', 'rpc/mod_workflow_tick'],
    ready: 'tbody[data-rows] tr[data-row]',
  },
  {
    id: 'users',
    handoff: '用户',
    nav: 'users',
    label: '用户',
    path: '/admin/users/',
    migration: '0009',
    endpoints: ['rpc/mod_list_users'],
    ready: 'tbody[data-rows] tr[data-row]',
  },
  {
    id: 'reports',
    handoff: '举报',
    nav: 'reports',
    label: '举报队列',
    path: '/admin/reports/',
    migration: '0003',
    // forum_threads：被举报目标的预览（有举报时才请求）
    endpoints: ['reports', 'forum_threads'],
    ready: '[data-report], .report, [data-table-empty]',
  },
  {
    id: 'guestbook',
    handoff: '留言',
    nav: 'guestbook',
    label: '留言审核',
    path: '/admin/guestbook/',
    migration: '0015',
    endpoints: ['guestbook_entries'],
    ready: '[data-table-empty], .mod-item',
  },
  {
    id: 'links',
    handoff: '友链',
    nav: 'links',
    label: '友链审核',
    path: '/admin/links/',
    migration: '0015',
    endpoints: ['rpc/admin_list_friend_links'],
    ready: '[data-table-empty], .mod-item',
  },
  {
    id: 'subscribers',
    handoff: '订阅',
    nav: 'subscribers',
    label: '邮件订阅',
    path: '/admin/subscribers/',
    migration: '0016',
    endpoints: ['rpc/admin_subscriber_counts'],
    ready: '[data-status-row]',
  },
  {
    id: 'audit',
    handoff: '审计',
    nav: 'audit',
    label: '审计日志',
    path: '/admin/audit/',
    migration: '0003',
    endpoints: ['audit_log'],
    ready: 'tbody[data-rows] tr, [data-table-empty]',
  },
] as const;

export type AdminReadModule = (typeof ADMIN_READ_MODULES)[number];
export type AdminReadModuleId = AdminReadModule['id'];
