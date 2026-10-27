/**
 * 后台读取失败的分类与提示（A15 / T091）。
 * 以前所有失败都归为 DataUnavailableError →「网络或服务暂时不可用」，连「数据库没迁移（HTTP 404 PGRST202）」也一样，
 * 站长无法判断该检查网络还是执行迁移。这里按原因分开：
 *   schema      数据库缺少 RPC / 表（迁移未执行）——重试不会恢复，给出迁移编号
 *   network     请求没有到达服务器（断网 / DNS / CORS 拦截）
 *   timeout     超过等待时间
 *   server      服务端 5xx
 *   auth        登录失效（需要重新登录）
 *   permission  数据库拒绝（RLS / 角色 / 封禁）
 *   other       其他（显示数据库给出的中文原因或兜底文案）
 * 「真实空集」不是错误：由各模块的空态显示。
 */
import { friendlyError } from './community-errors';
import { DataUnavailableError, ForbiddenError, NotSignedInError, SchemaMissingError } from './data/types';
import { migrationOf } from './data/schema-map';

export type AdminErrorKind = 'schema' | 'network' | 'timeout' | 'server' | 'auth' | 'permission' | 'other';

export interface AdminErrorInfo {
  kind: AdminErrorKind;
  /** 一句话标题 */
  title: string;
  /** 原因与下一步 */
  text: string;
  /** 重试按钮文字（schema：重新检测；其余：重试） */
  retryLabel: string;
}

export function describeAdminError(e: unknown, fallback = '加载失败，请稍后再试。'): AdminErrorInfo {
  if (e instanceof SchemaMissingError) {
    // 数据层（含留言板 / 友链 / 订阅这类公开与后台共用的接口）不带迁移编号表，这里按对象名补上
    const migration = e.migration ?? migrationOf(e.object);
    const need = migration ? `迁移 ${migration}` : '相关迁移';
    return {
      kind: 'schema',
      title: `数据库未就绪：缺少「${e.object}」`,
      text: `当前连接的数据库还没有执行${need}（PostgREST ${e.code}）。这不是网络问题，重试不会恢复；请站长按 docs/MIGRATION.md 执行缺失的迁移后再点「重新检测」。`,
      retryLabel: '重新检测',
    };
  }
  if (e instanceof DataUnavailableError) {
    if (e.kind === 'timeout')
      return {
        kind: 'timeout',
        title: '请求超时',
        text: '数据服务在规定时间内没有响应，请稍后重试。',
        retryLabel: '重试',
      };
    if (e.kind === 'server' || e.kind === 'bad-response')
      return {
        kind: 'server',
        title: e.status ? `服务端出错（HTTP ${e.status}）` : '服务端返回异常',
        text: '数据服务暂时出错，请稍后重试；持续出现请查看数据库服务日志。',
        retryLabel: '重试',
      };
    return {
      kind: 'network',
      title: '无法连接数据服务',
      text: '请求没有到达服务器（网络断开或被拦截），请检查网络后重试。',
      retryLabel: '重试',
    };
  }
  if (e instanceof NotSignedInError)
    return { kind: 'auth', title: '登录已失效', text: '请重新登录后再试。', retryLabel: '重试' };
  if (e instanceof ForbiddenError)
    return {
      kind: 'permission',
      title: '没有权限',
      text: friendlyError(e, '数据库拒绝了这次读取（权限或账号状态），请确认当前账号的角色。'),
      retryLabel: '重试',
    };
  return { kind: 'other', title: '加载失败', text: friendlyError(e, fallback), retryLabel: '重试' };
}

/** 一行文字版（toast / 状态栏用） */
export const adminErrorLine = (e: unknown, fallback?: string) => {
  const i = describeAdminError(e, fallback);
  return i.kind === 'other' ? i.text : `${i.title}：${i.text}`;
};
