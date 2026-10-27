/**
 * 后台 / 社区接口用到的数据库对象 → 创建它的迁移编号（A15）。
 * 用途：PostgREST 报「找不到函数 / 表」时，告诉站长具体缺哪一个迁移，而不是笼统的「网络不可用」。
 * tests/unit/schema-map.test.ts 会逐项核对：每个对象确实在对应的迁移文件里被创建。
 */
export const OBJECT_MIGRATION: Record<string, string> = {
  // 0003 社交表
  reports: '0003',
  audit_log: '0003',
  notifications: '0003',
  likes: '0003',
  bookmarks: '0003',
  // 0004 函数
  like_summary: '0004',
  unread_notification_count: '0004',
  mark_notifications_read: '0004',
  // 0008 论坛搜索
  search_threads: '0008',
  thread_reply_counts: '0008',
  // 0009 管理后台
  admin_stats: '0009',
  mod_list_content: '0009',
  mod_list_users: '0009',
  mod_handle_reports: '0009',
  mod_ban_user: '0009',
  mod_unban_user: '0009',
  mod_warn_user: '0009',
  mod_lift_expired_bans: '0009',
  user_bans: '0009',
  // 0012 应用商店
  app_reviews: '0012',
  // 0015 留言板 / 友链
  guestbook_entries: '0015',
  friend_links: '0015',
  admin_list_friend_links: '0015',
  admin_friend_link_set_status: '0015',
  admin_friend_link_delete: '0015',
  mod_guestbook_set_status: '0015',
  mod_guestbook_delete: '0015',
  // 0016 邮件订阅
  subscribers: '0016',
  admin_subscriber_counts: '0016',
  // 0017 后台 CRM
  admin_notes: '0017',
  admin_user_tags: '0017',
  content_workflow: '0017',
  content_versions: '0017',
  mod_user_profile: '0017',
  mod_set_workflow: '0017',
  mod_workflow_tick: '0017',
  // 0019 站长第二轮：恢复回到待审 + 显式发布
  mod_publish_content: '0019',
};

/** 0017 才有的「排序参数」版本（旧函数存在但签名不同） */
export const SORT_MIGRATION = '0017';

/** PostgREST 路径（`rpc/name?…` / `table?…`）→ 对象名 */
export function objectFromPath(path: string): string {
  const p = path.split('?')[0].replace(/^\/+/, '');
  return p.startsWith('rpc/') ? p.slice(4) : p;
}

export const migrationOf = (object: string): string | null => OBJECT_MIGRATION[object] ?? null;
