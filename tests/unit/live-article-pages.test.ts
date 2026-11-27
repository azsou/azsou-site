import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DetailPage from '@/pages/articles/live/[slug].astro';
import IndexPage from '@/pages/articles/live/index.astro';

// App-level render of the two local pilot pages with a stubbed backend. Not an HTTP route check.
const LOCAL = 'http://127.0.0.1:4321';
const REST =
  /^http:\/\/127\.0\.0\.1:54321\/rest\/v1\/rpc\/(az_cms_read_published_article|az_cms_list_published_articles)$/;

type Call = { url: string; init: RequestInit; body: unknown };

function backend(reply: (url: string, body: unknown) => Response | Promise<Response> | Error) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
      calls.push({ url, init: init ?? {}, body });
      const out = await reply(url, body);
      if (out instanceof Error) throw out;
      return out;
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(page: Parameters<AstroContainer['renderToResponse']>[0], url: string, slug?: string) {
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(page, {
    request: new Request(url),
    routeType: 'page',
    ...(slug === undefined ? {} : { params: { slug } }),
  });
  const html = await response.text();
  return { response, html, view: view(html) };
}

const decode = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// Reads only what the first HTML response contains inside <main>; no scripts run.
function view(html: string) {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  const main = start >= 0 && end > start ? html.slice(start, end) : '';
  const first = (pattern: RegExp) => {
    const match = pattern.exec(main);
    return match ? decode(match[1]!) : null;
  };
  return {
    hasMain: main !== '',
    h1: first(/<h1[^>]*>([\s\S]*?)<\/h1>/),
    pre: first(/<pre[^>]*>([\s\S]*?)<\/pre>/),
    text: decode(main.replace(/<[^>]*>/g, '')),
    alert: /role="alert"/.test(main),
    list: /<ul[\s>]/.test(main),
    rawBold: /<b[\s>]/.test(main),
    links: [...main.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
      href: decode(m[1]!),
      text: decode(m[2]!),
    })),
  };
}

const row = (slug: string, title = slug) => ({ slug, revision: 1, title });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('本机试点：已发布文章列表页', () => {
  it('首份 HTML 就有标题和链接，文字被转义，只读公开目录', async () => {
    const calls = backend(() => json([row('alpha', '甲 <b>x</b>'), row('beta', '乙')]));
    const { response, view: page, html } = await render(IndexPage, `${LOCAL}/articles/live/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(page.hasMain).toBe(true);
    expect(page.h1).toBe('已发布文章（本机试点）');
    expect(page.links.map((a) => a.href)).toEqual(['/articles/live/alpha/', '/articles/live/beta/']);
    expect(page.links.map((a) => a.text)).toEqual(['甲 <b>x</b>', '乙']);
    expect(page.rawBold).toBe(false);
    expect(html).not.toContain('<b>x</b>');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(REST);
    expect(calls[0]!.url).toContain('az_cms_list_published_articles');
    expect(calls[0]!.body).toEqual({ p_after_slug: null, p_limit: 20 });
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
  });

  it('满一页时带下一页游标，下一页请求使用它', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`a${String(i + 1).padStart(2, '0')}`));
    const first = backend(() => json(rows));
    const page = await render(IndexPage, `${LOCAL}/articles/live/`);
    expect(
      page.view.links.filter((a) => a.href.startsWith('/articles/live/?after=')).map((a) => a.href),
    ).toEqual(['/articles/live/?after=a20']);
    expect(first).toHaveLength(1);
    vi.unstubAllGlobals();
    const second = backend(() => json([row('a21')]));
    const next = await render(IndexPage, `${LOCAL}/articles/live/?after=a20`);
    expect(next.response.status).toBe(200);
    expect(second[0]!.body).toEqual({ p_after_slug: 'a20', p_limit: 20 });
    expect(next.view.links.filter((a) => a.href.startsWith('/articles/live/?after='))).toEqual([]);
  });

  it('空页是 200，读取失败是 503，两者不混淆', async () => {
    backend(() => json([]));
    const empty = await render(IndexPage, `${LOCAL}/articles/live/`);
    expect(empty.response.status).toBe(200);
    expect(empty.view.text).toContain('本页没有已发布文章。');
    for (const failure of [json({ message: 'down' }, 503), json([{ slug: 'alpha' }]), new Error('network')]) {
      vi.unstubAllGlobals();
      backend(() => failure);
      const failed = await render(IndexPage, `${LOCAL}/articles/live/`);
      expect(failed.response.status).toBe(503);
      expect(failed.view.alert).toBe(true);
      expect(failed.view.list).toBe(false);
      expect(failed.view.text).not.toContain('本页没有已发布文章。');
    }
  });

  it('坏游标和非本机访问在读取前被拒绝', async () => {
    const calls = backend(() => json([]));
    for (const query of ['?after=Bad_Slug', '?after=a&after=b', '?after=']) {
      const bad = await render(IndexPage, `${LOCAL}/articles/live/${query}`);
      expect(bad.response.status).toBe(400);
    }
    const remote = await render(IndexPage, 'https://azsou.com/articles/live/');
    expect(remote.response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('本机试点：已发布文章详情页', () => {
  it('首份 HTML 就有标题、版本和正文，正文只作文本', async () => {
    const body = '第一行\n<script>window.x = 1</script>';
    const calls = backend(() => json([{ slug: 'alpha', revision: 2, title: '甲', body_text: body }]));
    const { response, view: page, html } = await render(DetailPage, `${LOCAL}/articles/live/alpha/`, 'alpha');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(page.hasMain).toBe(true);
    expect(page.h1).toBe('甲');
    expect(page.text).toContain('已发布第 2 版');
    expect(page.pre).toBe(body);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<script>window.x');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(REST);
    expect(calls[0]!.url).toContain('az_cms_read_published_article');
    expect(calls[0]!.body).toEqual({ p_slug: 'alpha' });
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
  });

  it('未发布或已下架是真 404，后端故障是 503，不显示旧正文', async () => {
    backend(() => json([]));
    const absent = await render(DetailPage, `${LOCAL}/articles/live/alpha/`, 'alpha');
    expect(absent.response.status).toBe(404);
    expect(absent.view.h1).toBe('文章不存在或已下架');
    expect(absent.view.pre).toBeNull();
    const broken = [
      json({ message: 'down' }, 500),
      json([{ slug: 'alpha', revision: 1, title: '甲' }]),
      json([{ slug: 'beta', revision: 1, title: '乙', body_text: '串了' }]),
      new Error('network'),
    ];
    for (const failure of broken) {
      vi.unstubAllGlobals();
      backend(() => failure);
      const failed = await render(DetailPage, `${LOCAL}/articles/live/alpha/`, 'alpha');
      expect(failed.response.status).toBe(503);
      expect(failed.view.alert).toBe(true);
      expect(failed.view.pre).toBeNull();
      expect(failed.html).not.toContain('串了');
    }
  });

  it('非法标识和非本机访问在读取前返回 404', async () => {
    const calls = backend(() => json([{ slug: 'alpha', revision: 1, title: '甲', body_text: '不应出现' }]));
    for (const slug of ['Bad_Slug', 'a-', 'x'.repeat(81)]) {
      const bad = await render(DetailPage, `${LOCAL}/articles/live/${slug}/`, slug);
      expect(bad.response.status).toBe(404);
    }
    const remote = await render(DetailPage, 'https://azsou.com/articles/live/alpha/', 'alpha');
    expect(remote.response.status).toBe(404);
    expect(remote.html).not.toContain('不应出现');
    expect(calls).toHaveLength(0);
  });
});

const PREVIEW_HOST = 'azsou-site-git-feat-sb03-article-draft-pilot-azsous-projects.vercel.app';
const PREVIEW = `https://${PREVIEW_HOST}`;
const TEST_REST =
  /^https:\/\/ovvfwkmqlejcpatmfqcd\.supabase\.co\/rest\/v1\/rpc\/(az_cms_read_published_article|az_cms_list_published_articles)$/;

function previewEnv(vercelEnv = 'preview', url = 'https://ovvfwkmqlejcpatmfqcd.supabase.co') {
  vi.stubEnv('VERCEL_ENV', vercelEnv);
  vi.stubEnv('PUBLIC_SUPABASE_URL', url);
  vi.stubEnv('PUBLIC_SUPABASE_KEY', 'sb_publishable_preview-test-not-a-secret');
}

describe('固定预览部署：只读测试库的公开目录和正文', () => {
  it('列表页在固定预览域名返回 200，只读测试库，响应头不缓存且不收录', async () => {
    previewEnv();
    const calls = backend(() => json([row('alpha', '甲'), row('beta', '乙')]));
    const { response, view: page } = await render(IndexPage, `${PREVIEW}/articles/live/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(page.links.map((a) => a.href)).toEqual(['/articles/live/alpha/', '/articles/live/beta/']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(TEST_REST);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
  });

  it('列表为空是 200，详情页首份 HTML 就有正文', async () => {
    previewEnv();
    backend(() => json([]));
    const empty = await render(IndexPage, `${PREVIEW}/articles/live/`);
    expect(empty.response.status).toBe(200);
    expect(empty.view.text).toContain('本页没有已发布文章。');
    vi.unstubAllGlobals();
    const calls = backend(() => json([{ slug: 'alpha', revision: 3, title: '甲', body_text: '正文一' }]));
    const detail = await render(DetailPage, `${PREVIEW}/articles/live/alpha/`, 'alpha');
    expect(detail.response.status).toBe(200);
    expect(detail.response.headers.get('cache-control')).toBe('no-store');
    expect(detail.view.h1).toBe('甲');
    expect(detail.view.pre).toBe('正文一');
    expect(calls[0]!.url).toMatch(TEST_REST);
  });

  it('其它域名、非预览环境一律 404，且不读取后端', async () => {
    const cases: Array<[string, string]> = [
      [PREVIEW_HOST, 'production'],
      [PREVIEW_HOST, 'development'],
      ['azsou-site-abc123-azsous-projects.vercel.app', 'preview'],
      ['azsou.com', 'preview'],
      [`${PREVIEW_HOST}.evil.example`, 'preview'],
    ];
    for (const [host, vercelEnv] of cases) {
      previewEnv(vercelEnv);
      const calls = backend(() => json([{ slug: 'alpha', revision: 1, title: '甲', body_text: '不应出现' }]));
      const list = await render(IndexPage, `https://${host}/articles/live/`);
      const detail = await render(DetailPage, `https://${host}/articles/live/alpha/`, 'alpha');
      expect(list.response.status).toBe(404);
      expect(detail.response.status).toBe(404);
      expect(detail.html).not.toContain('不应出现');
      expect(calls).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it('固定预览域名但数据库地址不是测试库时是 503，不读取后端', async () => {
    for (const url of ['http://127.0.0.1:54321', 'https://example.supabase.co']) {
      previewEnv('preview', url);
      const calls = backend(() => json([]));
      const list = await render(IndexPage, `${PREVIEW}/articles/live/`);
      const detail = await render(DetailPage, `${PREVIEW}/articles/live/alpha/`, 'alpha');
      expect(list.response.status).toBe(503);
      expect(detail.response.status).toBe(503);
      expect(calls).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });
});
