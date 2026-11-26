import { readPublishedArticle, validPublicArticleSlug } from '@/lib/data/published-article';
import { classifySupabaseUrl, supabaseConfig } from '@/lib/supabase-config';

async function init() {
  const root = document.querySelector<HTMLElement>('[data-published-article]');
  if (!root) return;
  const status = root.querySelector<HTMLElement>('[data-article-public-status]')!;
  const result = root.querySelector<HTMLElement>('[data-article-public-result]')!;
  const title = root.querySelector<HTMLElement>('[data-article-public-title]')!;
  const edition = root.querySelector<HTMLElement>('[data-article-public-version]')!;
  const body = root.querySelector<HTMLElement>('[data-article-public-body]')!;
  function clear() {
    result.hidden = true;
    title.textContent = '文章详情';
    edition.textContent = '';
    body.textContent = '';
  }

  clear();
  const slugs = new URLSearchParams(location.search).getAll('slug');
  const slug = slugs.length === 1 ? slugs[0] : '';
  if (!slug || !validPublicArticleSlug(slug)) {
    status.textContent = '文章链接缺少有效标识。';
    return;
  }
  status.textContent = '正在读取文章…';
  try {
    const config = supabaseConfig();
    const target = classifySupabaseUrl(config.url)?.target;
    if (target !== 'test' && target !== 'local') {
      status.textContent = '此试点页仅在测试环境开放。';
      return;
    }
    const article = await readPublishedArticle(config, slug);
    if (!article) {
      status.textContent = '这篇文章尚未发布或已下架。';
      return;
    }
    title.textContent = article.title;
    edition.textContent = `已发布第 ${article.revision} 版`;
    body.textContent = article.bodyText;
    result.hidden = false;
    status.textContent = '';
  } catch {
    clear();
    status.textContent = '读取失败，没有显示文章内容。';
  }
}

void init();
