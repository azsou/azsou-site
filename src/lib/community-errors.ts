/**
 * 仓储错误 → 给用户看的中文提示（论坛 / 评论 / 收藏 / 举报共用）。
 * 限流（HTTP 429 / SQLSTATE PT429）根据数据库给出的 detail 说明「每多久最多几次」。
 */
import {
  DataUnavailableError,
  ForbiddenError,
  NotSignedInError,
  RateLimitedError,
  ValidationError,
} from './data/types';

const ACTIONS: Record<string, string> = {
  thread: '发主题',
  thread_day: '发主题',
  reply: '回复',
  reply_hour: '回复',
  comment: '评论',
  comment_hour: '评论',
  like: '点赞',
  bookmark: '收藏',
  report: '举报',
  profile_update: '修改昵称',
};

/** Postgres interval 文本（00:10:00 / 1 day / 01:00:00）→ 中文 */
export function intervalText(iv: string): string {
  const s = iv.trim();
  const day = /^(\d+)\s+days?$/.exec(s);
  if (day) return `${Number(day[1])} 天`;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) {
    const [h, m, sec] = hms.slice(1).map(Number);
    if (h && !m && !sec) return `${h} 小时`;
    if (!h && m && !sec) return `${m} 分钟`;
    if (!h && !m) return `${sec} 秒`;
    return `${h * 60 + m} 分钟`;
  }
  return s;
}

/** detail 形如「thread: 最多 3 次 / 00:10:00」 */
export function rateLimitMessage(detail = ''): string {
  const m = /^([a-z_]+):\s*最多\s*(\d+)\s*次\s*\/\s*(.+)$/.exec(detail.trim());
  if (!m) return '操作太频繁了，请稍等一会儿再试。';
  const what = ACTIONS[m[1]] ?? '操作';
  return `${what}太频繁了：为防止刷屏，每 ${intervalText(m[3])}最多${what} ${m[2]} 次。请稍后再试。`;
}

export function friendlyError(e: unknown, fallback = '操作失败，请稍后再试。'): string {
  if (e instanceof RateLimitedError) return rateLimitMessage(e.detail);
  if (e instanceof NotSignedInError) return '请先登录。';
  if (e instanceof ForbiddenError) {
    const m = e.message;
    if (/锁定/.test(m)) return '这个主题已锁定，不能再回复或编辑。';
    if (/公告/.test(m)) return '只有管理员可以在「公告」发帖。';
    if (/限制发言|banned/i.test(m)) return '你的账号已被限制发言。';
    return m || '没有权限执行这个操作。';
  }
  if (e instanceof ValidationError) {
    if (e.message === '已经提交过了') return '你已经提交过了，无需重复操作。';
    return e.message;
  }
  if (e instanceof DataUnavailableError) return '网络或服务暂时不可用，请检查网络后重试。';
  return fallback;
}
