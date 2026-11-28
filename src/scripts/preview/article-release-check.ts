import { CANARY_SLUG, readPublishedCanary } from '@/lib/data/article-canary';
import { classifySupabaseUrl, supabaseConfig } from '@/lib/supabase-config';

async function init() {
  const root = document.querySelector<HTMLElement>('[data-article-release-check]');
  if (!root) return;
  const status = root.querySelector<HTMLElement>('[data-check-status]')!;
  const result = root.querySelector<HTMLElement>('[data-check-result]')!;
  const title = root.querySelector<HTMLElement>('[data-check-title]')!;
  const version = root.querySelector<HTMLElement>('[data-check-version]')!;
  const body = root.querySelector<HTMLElement>('[data-check-body]')!;
  const button = root.querySelector<HTMLButtonElement>('[data-check-read]')!;
  const config = supabaseConfig();
  const target = classifySupabaseUrl(config.url)?.target;
  if (target !== 'test' && target !== 'local') {
    status.textContent = '这个页面只在测试环境可用。';
    return;
  }
  let token = 0;
  async function check() {
    const mine = ++token;
    button.disabled = true;
    result.hidden = true;
    status.textContent = '正在以访客身份读取…';
    try {
      const found = await readPublishedCanary(config);
      if (mine !== token) return;
      if (!found) {
        status.textContent = `访客读不到 ${CANARY_SLUG}：没有已发布的版本。`;
        return;
      }
      title.textContent = found.title;
      version.textContent = `已发布第 ${found.revision} 版`;
      body.textContent = found.bodyText;
      result.hidden = false;
      status.textContent = '访客可以读到这篇文章。';
    } catch {
      if (mine === token) status.textContent = '读取失败，没有显示任何内容。可以再点一次。';
    } finally {
      if (mine === token) button.disabled = false;
    }
  }
  button.addEventListener('click', () => void check());
  void check();
}

void init();
