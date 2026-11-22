/**
 * 站长的公开账号（T7.4）：src/data/social.json。只显示有 url 的账号——没有核实到地址的平台整项隐藏，
 * 不放空链接 / 占位链接（tests/unit/social.test.ts 检查）。
 */
import data from '../data/social.json';

export type SocialId = 'github' | 'rss' | 'bilibili' | 'youtube' | 'email';
export interface SocialAccount {
  id: SocialId;
  name: string;
  handle: string | null;
  url: string | null;
  verified: string;
}

export const ALL_SOCIAL = data.accounts as SocialAccount[];
export const SOCIAL = ALL_SOCIAL.filter((a): a is SocialAccount & { url: string } => !!a.url);
/** 站外账号（Person.sameAs 用；RSS 是本站自己的，不算） */
export const sameAs = () => SOCIAL.filter((a) => /^https:\/\//.test(a.url)).map((a) => a.url);
