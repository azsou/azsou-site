/**
 * 公开联系方式（P8 T8.2）。邮箱由站长通过环境变量 PUBLIC_CONTACT_EMAIL 提供（不写进仓库，避免被爬虫收集前先确认要公开哪个地址）；
 * 没设时联系页与隐私政策只列站内渠道（留言板、论坛反馈帖、GitHub）。
 */
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export function contactEmail(env: { PUBLIC_CONTACT_EMAIL?: string }): string | null {
  const v = (env.PUBLIC_CONTACT_EMAIL ?? '').trim();
  return EMAIL_RE.test(v) && v.length <= 254 ? v : null;
}
/** 法律页「最后更新」日期（改动隐私 / Cookie / 披露 / 条款内容时一并修改） */
export const LEGAL_UPDATED = '2026-10-25';
export const GITHUB_ISSUES = 'https://github.com/azsou/azsou-site/issues';
