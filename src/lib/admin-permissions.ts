/**
 * 权限矩阵（P10h T10.22）：后台各能力 × 角色。只是把数据库里已经强制的规则列成表给人看——
 * 真正的判断在 RLS / SECURITY DEFINER RPC 里（每行的 source 指向对应迁移），界面隐藏只为体验。
 */
export type MatrixRole = 'user' | 'moderator' | 'admin';
export const MATRIX_ROLES: { id: MatrixRole; label: string }[] = [
  { id: 'user', label: '普通用户' },
  { id: 'moderator', label: '版主' },
  { id: 'admin', label: '管理员' },
];
export interface Capability {
  group: string;
  label: string;
  roles: MatrixRole[];
  source: string;
}
export const CAPABILITIES: Capability[] = [
  {
    group: '后台',
    label: '进入管理后台（概览、内容、用户、举报、留言、官方内容）',
    roles: ['moderator', 'admin'],
    source: '0009 az_require_moderator()',
  },
  {
    group: '社区',
    label: '处理举报（单条 / 批量，附带隐藏 / 锁定 / 封禁 / 警告）',
    roles: ['moderator', 'admin'],
    source: '0009 mod_handle_reports',
  },
  {
    group: '社区',
    label: '隐藏 / 恢复 / 删除主题、回复与评论，锁定 / 置顶主题',
    roles: ['moderator', 'admin'],
    source: '0006 RLS + 0009',
  },
  {
    group: '社区',
    label: '审核留言板留言',
    roles: ['moderator', 'admin'],
    source: '0015 mod_guestbook_set_status',
  },
  { group: '社区', label: '审核友情链接', roles: ['admin'], source: '0015 admin_friend_link_set_status' },
  {
    group: '用户',
    label: '封禁 / 解封 / 警告普通用户',
    roles: ['moderator', 'admin'],
    source: '0009 mod_ban_user / mod_unban_user / mod_warn_user',
  },
  { group: '用户', label: '封禁版主或管理员', roles: ['admin'], source: '0009 mod_ban_user' },
  { group: '用户', label: '修改用户角色', roles: ['admin'], source: '0009 admin_set_user' },
  { group: '用户', label: '封禁或降级自己', roles: [], source: '0009（任何角色都不行）' },
  { group: '系统', label: '查看与导出审计日志', roles: ['admin'], source: '0006 audit_admin_read' },
  {
    group: '系统',
    label: '站点设置（公告、注册开关、论坛分类）',
    roles: ['admin'],
    source: '0009 site_content 设置',
  },
  { group: '系统', label: '导入导出数据、邮件订阅名单', roles: ['admin'], source: '0009 / 0016' },
];
