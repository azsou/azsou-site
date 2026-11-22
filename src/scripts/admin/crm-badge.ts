/** 内容流程状态徽标（首屏同步加载的那一小部分；抽屉等重组件在 crm.ts，懒加载） */
import type { WorkflowStatus } from '@/lib/data/admin';
import { dateTime, h } from './shell';

export const WF_LABEL: Record<WorkflowStatus, string> = {
  draft: '草稿',
  review: '待审',
  published: '已发布',
  offline: '已隐藏',
};
const WF_BADGE: Record<WorkflowStatus, string> = {
  draft: 'badge--muted',
  review: 'badge--info',
  published: 'badge--ok',
  offline: 'badge--danger',
};
export const wfBadge = (s: WorkflowStatus, at?: string | null) =>
  h('span', {
    class: `badge ${WF_BADGE[s]}`,
    'data-wf': s,
    text: at && s === 'review' ? `定时 ${dateTime(at)}` : WF_LABEL[s],
  });

/** 后台 CRM 扩展接口（懒加载 admin-crm-api，公开页面不打包） */
export async function crmApi() {
  const [{ createCrmApi }, { adminRepo }] = await Promise.all([
    import('@/lib/data/admin-crm-api'),
    import('./shell'),
  ]);
  return createCrmApi(adminRepo().raw());
}
