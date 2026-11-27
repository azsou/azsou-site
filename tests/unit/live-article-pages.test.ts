import { JSDOM } from 'jsdom';
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
  return { response, html, doc: new JSDOM(html).window.document };
}

const row = (slug: string, title = slug) => ({ slug, revision: 1, title });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('本机试点：已发布文章列表页', () => {
  it('首份 HTML 就有标题和链接，文字被转义，只读公开目录', async () => {
    const calls = backend(() => json([row('alpha', '甲 <b>x</b>'), row('beta', '乙')]));
    const { response, doc, html } = await render(IndexPage, `${LOCAL}/articles/live/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(doc.querySelector('main h1')?.textContent).toBe('已发布文章（本机试点）');
    const links = [...doc.querySelectorAll('main ul a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/articles/live/alpha/',
      '/articles/live/beta/',
    ]);
    expect(links.map((a) => a.textContent)).toEqual(['甲 <b>x</b>', '乙']);
    expect(doc.querySelector('main b')).toBeNull();
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
    expect(page.doc.querySelector('main a[href^="/articles/live/?after="]')?.getAttribute('href')).toBe(
      '/articles/live/?after=a20',
    );
    expect(first).toHaveLength(1);
    vi.unstubAllGlobals();
    const second = backend(() => json([row('a21')]));
    const next = await render(IndexPage, `${LOCAL}/articles/live/?after=a20`);
    expect(next.response.status).toBe(200);
    expect(second[0]!.body).toEqual({ p_after_slug: 'a20', p_limit: 20 });
    expect(next.doc.querySelector('main a[href^="/articles/live/?after="]')).toBeNull();
  });

  it('空页是 200，读取失败是 503，两者不混淆', async () => {
    backend(() => json([]));
    const empty = await render(IndexPage, `${LOCAL}/articles/live/`);
    expect(empty.response.status).toBe(200);
    expect(empty.doc.querySelector('main')?.textContent).toContain('本页没有已发布文章。');
    for (const failure of [json({ message: 'down' }, 503), json([{ slug: 'alpha' }]), new Error('network')]) {
      vi.unstubAllGlobals();
      backend(() => failure);
      const failed = await render(IndexPage, `${LOCAL}/articles/live/`);
      expect(failed.response.status).toBe(503);
      expect(failed.doc.querySelector('main [role="alert"]')).not.toBeNull();
      expect(failed.doc.querySelector('main ul')).toBeNull();
      expect(failed.doc.querySelector('main')?.textContent).not.toContain('本页没有已发布文章。');
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
    const { response, doc, html } = await render(DetailPage, `${LOCAL}/articles/live/alpha/`, 'alpha');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(doc.querySelector('main h1')?.textContent).toBe('甲');
    expect(doc.querySelector('main')?.textContent).toContain('已发布第 2 版');
    expect(doc.querySelector('main pre')?.textContent).toBe(body);
    expect(doc.querySelectorAll('script')).toHaveLength(0);
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
    expect(absent.doc.querySelector('main h1')?.textContent).toBe('文章不存在或已下架');
    expect(absent.doc.querySelector('main pre')).toBeNull();
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
      expect(failed.doc.querySelector('main [role="alert"]')).not.toBeNull();
      expect(failed.doc.querySelector('main pre')).toBeNull();
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
