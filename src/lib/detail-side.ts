/**
 * 详情页导流区数据（P10 T10.13）：同类替代 → 同开发者 → 编辑推荐，三组互不重复；相关文章取
 * 「条目里写明的 relatedArticles」+「正文链接到本详情页的文章」（真实关联，不按关键词猜）。
 */
import type { SideGroup } from '@/components/detail/DetailSide.astro';
import { formatDate } from './dates';
import type { Article } from './content';
import { url } from './routes';
import { alternatives, editorPicks, sameDeveloper, type StoreEntry } from './store';

export function sideGroups(
  self: StoreEntry,
  all: StoreEntry[],
  opts: { more: { href: string; label: string }; typeNoun: string },
): SideGroup[] {
  const alt = alternatives(self, all, 5);
  const dev = sameDeveloper(
    self,
    all.filter((x) => !alt.some((a) => a.slug === x.slug)),
    4,
  );
  const picks = editorPicks(self.slug, all, [...alt, ...dev], 4);
  return [
    { id: 'alt', title: '同类替代', note: `同分类的${opts.typeNoun}`, more: opts.more, entries: alt },
    {
      id: 'same-dev',
      title: '同一开发者',
      note: self.developerName,
      entries: dev,
    },
    { id: 'picks', title: '编辑推荐', note: '按编辑推荐顺序', entries: picks },
  ];
}

export function relatedArticleLinks(articles: Article[], path: string, explicit: string[] = []) {
  const re = new RegExp(`href="${path.replace(/[/.]/g, '\\$&')}(#[^"]*)?"`);
  return articles
    .filter((a) => explicit.includes(a.id) || re.test(a.body ?? ''))
    .slice(0, 5)
    .map((a) => ({ title: a.data.title, href: url.article(a.id), meta: formatDate(a.data.date) }));
}
