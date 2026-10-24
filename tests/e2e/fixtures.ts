import { test as base, expect, type Page } from '@playwright/test';

/** Supabase REST 假数据：E2E 不依赖线上数据库，结果可复现 */
export const DB = {
  threads: [
    {
      id: '11111111-2222-3333-4444-555555555555',
      cat: '技术交流',
      title: 'E2E 用户主题',
      body: '这是一条来自数据库的主题。\n\n<img src=x onerror="window.__xss=1">',
      author: 'u-1',
      pinned: false,
      published: true,
      created_at: '2026-07-27T12:19:00Z',
      profiles: { display_name: '测试用户' },
    },
  ],
  replies: [
    {
      id: 'r-1',
      thread_id: '11111111-2222-3333-4444-555555555555',
      body: '数据库回复',
      author: 'u-1',
      created_at: '2026-07-27T12:24:00Z',
      profiles: { display_name: '测试用户' },
    },
    {
      id: 'r-2',
      thread_id: 't-announce',
      body: '种子主题下的数据库回复',
      author: 'u-2',
      created_at: '2026-07-28T01:00:00Z',
      profiles: { display_name: '另一位' },
    },
  ],
  comments: [
    {
      id: 'c-1',
      page_key: 'article:pinyin-initial-search',
      body: '<script>window.__xss=1</script>数据库评论',
      author: 'u-1',
      created_at: '2026-07-27T02:04:00Z',
      profiles: { display_name: '测试用户' },
    },
  ],
};

export async function mockSupabase(page: Page, mode: 'ok' | 'down' = 'ok') {
  await page.route('**/rest/v1/**', async (route) => {
    if (mode === 'down') return route.abort('connectionrefused');
    const u = new URL(route.request().url());
    const table = u.pathname.split('/').pop()!;
    const q = u.searchParams;
    const eq = (k: string) => q.get(k)?.replace(/^eq\./, '');
    let rows: Record<string, unknown>[] = [];
    if (table === 'forum_threads')
      rows = DB.threads
        .filter((t) => !eq('id') || t.id === eq('id'))
        .filter((t) => !eq('cat') || t.cat === eq('cat'))
        .filter((t) => !eq('pinned') || String(t.pinned) === eq('pinned'));
    if (table === 'forum_replies')
      rows = DB.replies.filter((r) => !eq('thread_id') || r.thread_id === eq('thread_id'));
    if (table === 'comments') rows = DB.comments.filter((c) => c.page_key === eq('page_key'));
    if (table === 'thread_reply_counts') {
      const keys = (route.request().postDataJSON()?.p_keys ?? []) as string[];
      rows = keys
        .map((k) => ({ thread_id: k, replies: DB.replies.filter((r) => r.thread_id === k).length }))
        .filter((r) => r.replies > 0);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}

/** Cloudflare Turnstile 假脚本：渲染一个占位并立刻回调测试 token（与官方测试 key 的行为一致） */
export const FAKE_TURNSTILE = `
  (function(){
    var widgets = {}, n = 0;
    window.turnstile = {
      render: function(el, o){
        var id = 'w' + (++n); widgets[id] = o;
        var b = document.createElement('div'); b.className = 'fake-turnstile'; b.textContent = '已通过人机验证（测试）';
        el.appendChild(b);
        setTimeout(function(){ o.callback && o.callback('XXXX.DUMMY.TOKEN.XXXX'); }, 20);
        return id;
      },
      reset: function(id){ var o = widgets[id]; if (o) setTimeout(function(){ o.callback && o.callback('XXXX.DUMMY.TOKEN.XXXX'); }, 20); }
    };
    if (window.azTurnstileReady) window.azTurnstileReady();
  })();`;

export async function mockTurnstile(page: Page) {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE }),
  );
}

type Fixtures = { errors: string[] };

/** 每个测试自动挂上假数据，并收集控制台错误与未捕获异常 */
export const test = base.extend<Fixtures>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => {
        // Chromium 在脚本触发的跨文档跳转（登录后 location.assign）时偶发中断视图转场，
        // 抛出的是浏览器内部 promise，页面代码无法捕获，对用户只是「这次没有动画」。
        if (/Transition was aborted because of invalid state/.test(e.message)) return;
        errors.push(`pageerror: ${e.message}`);
      });
      page.on('console', (m) => {
        if (
          m.type() === 'error' &&
          !/Failed to load resource|net::ERR|NS_ERROR|connection refused|Service ?Worker/i.test(m.text())
        )
          errors.push(`console: ${m.text()}`);
      });
      await mockSupabase(page);
      await mockTurnstile(page);
      await use(errors);
    },
    { auto: true },
  ],
});

export { expect };
