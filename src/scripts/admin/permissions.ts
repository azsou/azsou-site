/** /admin/permissions/：权限门 + 高亮当前账号所在的角色列（T10.22）。 */
import { initAdmin } from './shell';

void initAdmin().then((me) => {
  if (!me) return;
  document
    .querySelectorAll<HTMLElement>(`[data-perm-table] [data-role-col="${me.role}"]`)
    .forEach((c) => c.setAttribute('data-me', ''));
});
