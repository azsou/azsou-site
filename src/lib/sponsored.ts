/**
 * 联盟 / 赞助链接（P8 T8.7）。
 * 文章 frontmatter 的 `sponsoredLinks` 列出的地址，以及正文里带 data-sponsored 的链接，统一加上
 * rel="sponsored nofollow noopener"（Google 要求付费 / 联盟链接用 rel=sponsored），并在文首显示披露标识。
 * 只改 <a> 的 rel，不动其他内容；已有的 rel 值保留并去重。
 */
export const SPONSORED_REL = ['sponsored', 'nofollow', 'noopener'] as const;

const norm = (u: string) => u.replace(/&amp;/g, '&').replace(/\/$/, '');

export function markSponsored(html: string, urls: readonly string[] = []): string {
  const set = new Set(urls.map(norm));
  return html.replace(/<a\b([^>]*)>/g, (tag, attrs: string) => {
    const href = /\shref="([^"]*)"/.exec(attrs)?.[1];
    const flagged = /\sdata-sponsored(\s|=|$)/.test(attrs) || (href !== undefined && set.has(norm(href)));
    if (!flagged) return tag;
    const relM = /\srel="([^"]*)"/.exec(attrs);
    const rel = [...new Set([...(relM?.[1].split(/\s+/).filter(Boolean) ?? []), ...SPONSORED_REL])].join(' ');
    const next = relM ? attrs.replace(relM[0], ` rel="${rel}"`) : `${attrs} rel="${rel}"`;
    return `<a${next}>`;
  });
}

/** 正文里有多少个赞助 / 联盟链接（有就必须显示披露标识；单元测试与文章页共用） */
export function countSponsored(html: string): number {
  return [...html.matchAll(/<a\b[^>]*\srel="[^"]*\bsponsored\b[^"]*"/g)].length;
}
