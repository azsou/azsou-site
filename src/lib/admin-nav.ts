import type { IconName } from './lucide';

/**
 * 后台各页面：版主可见的在前，仅管理员的标 role=admin（导航与权限门共用）。
 * P10h T10.16：分组（概览 / 内容 / 社区 / 用户 / 运营 / 系统）+ 图标，侧栏折叠后只显示图标；⌘K 命令面板也读这张表。
 */
export const ADMIN_GROUPS = [
  { id: 'home', label: '' },
  { id: 'content', label: '内容' },
  { id: 'community', label: '社区' },
  { id: 'people', label: '用户' },
  { id: 'ops', label: '运营' },
  { id: 'system', label: '系统' },
] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number]['id'];

export const ADMIN_SECTIONS = [
  {
    id: 'dashboard',
    label: '概览',
    path: '/admin/',
    role: 'moderator',
    group: 'home',
    icon: 'layout-dashboard',
  },
  {
    id: 'content',
    label: '内容管理',
    path: '/admin/content/',
    role: 'moderator',
    group: 'content',
    icon: 'articles',
  },
  {
    id: 'official',
    label: '官方内容',
    path: '/admin/official/',
    role: 'moderator',
    group: 'content',
    icon: 'apps',
  },
  {
    id: 'reports',
    label: '举报队列',
    path: '/admin/reports/',
    role: 'moderator',
    group: 'community',
    icon: 'flag',
  },
  {
    id: 'guestbook',
    label: '留言审核',
    path: '/admin/guestbook/',
    role: 'moderator',
    group: 'community',
    icon: 'message',
  },
  { id: 'links', label: '友链审核', path: '/admin/links/', role: 'admin', group: 'community', icon: 'link' },
  { id: 'users', label: '用户', path: '/admin/users/', role: 'moderator', group: 'people', icon: 'users' },
  {
    id: 'subscribers',
    label: '邮件订阅',
    path: '/admin/subscribers/',
    role: 'admin',
    group: 'ops',
    icon: 'mail',
  },
  { id: 'audit', label: '审计日志', path: '/admin/audit/', role: 'admin', group: 'system', icon: 'history' },
  {
    id: 'settings',
    label: '站点设置',
    path: '/admin/settings/',
    role: 'admin',
    group: 'system',
    icon: 'settings',
  },
  { id: 'data', label: '导入导出', path: '/admin/data/', role: 'admin', group: 'system', icon: 'database' },
] as const satisfies readonly {
  id: string;
  label: string;
  path: string;
  role: 'moderator' | 'admin';
  group: AdminGroup;
  icon: IconName;
}[];

export type AdminSection = (typeof ADMIN_SECTIONS)[number]['id'];

/** 审计动作 → 中文说明（未知动作原样显示） */
export const AUDIT_LABELS: Record<string, string> = {
  'user.set_role': '修改角色 / 封禁状态',
  'user.ban': '封禁用户',
  'user.unban': '解除封禁',
  'user.ban_expired': '封禁到期解除',
  'user.warn': '警告用户',
  'report.resolved': '举报：已处理',
  'report.dismissed': '举报：驳回',
  'report.open': '举报：重新打开',
  'report.action.hide': '处理举报：隐藏内容',
  'report.action.lock': '处理举报：锁定主题',
  'report.action.ban': '处理举报：封禁作者',
  'report.action.warn': '处理举报：警告作者',
  'report.action.none': '处理举报',
  'thread.update': '修改主题',
  'thread.delete': '删除主题',
  'reply.update': '修改回复',
  'reply.delete': '删除回复',
  'comment.update': '修改评论',
  'comment.delete': '删除评论',
  'content.insert': '新增站点内容 / 设置',
  'content.update': '修改站点内容 / 设置',
  'content.delete': '删除站点内容 / 设置',
  'guestbook.approved': '留言：通过',
  'guestbook.rejected': '留言：拒绝',
  'guestbook.pending': '留言：退回待审核',
  'guestbook.delete': '留言：删除',
  'friend_link.approved': '友链：通过',
  'friend_link.rejected': '友链：拒绝',
  'friend_link.pending': '友链：退回待审核',
  'friend_link.delete': '友链：删除',
};

export const auditLabel = (action: string) => AUDIT_LABELS[action] ?? action;
