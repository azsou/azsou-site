import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_PREVIEW_HOST, liveGateDiagnostic } from '@/lib/data/live-article-gate';
import DetailPage from '@/pages/articles/live/[slug].astro';
import IndexPage from '@/pages/articles/live/index.astro';

async function render(page: Parameters<AstroContainer['renderToResponse']>[0], url: string, slug?: string) {
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(page, {
    request: new Request(url),
    routeType: 'page',
    ...(slug === undefined ? {} : { params: { slug } }),
  });
  return { response, html: await response.text() };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('试点页关闭原因的诊断文字', () => {
  it('非生产环境说明环境和主机，门开时没有诊断', () => {
    expect(liveGateDiagnostic({ hostname: 'wrong.example', dev: false, vercelEnv: 'preview' })).toBe(
      '诊断：环境=preview；主机匹配=否；主机=wrong.example',
    );
    expect(liveGateDiagnostic({ hostname: LIVE_PREVIEW_HOST, dev: false, vercelEnv: undefined })).toBe(
      `诊断：环境=未设置；主机匹配=是；主机=${LIVE_PREVIEW_HOST}`,
    );
    expect(liveGateDiagnostic({ hostname: LIVE_PREVIEW_HOST, dev: false, vercelEnv: 'preview' })).toBeNull();
    expect(liveGateDiagnostic({ hostname: '127.0.0.1', dev: true, vercelEnv: undefined })).toBeNull();
  });

  it('生产环境从不给诊断，异常环境值和超长主机被截断', () => {
    for (const hostname of [LIVE_PREVIEW_HOST, 'azsou.com', '127.0.0.1']) {
      expect(liveGateDiagnostic({ hostname, dev: true, vercelEnv: 'production' })).toBeNull();
    }
    const odd = liveGateDiagnostic({ hostname: 'h'.repeat(300), dev: false, vercelEnv: 'Prev iew<x>' });
    expect(odd).toBe(`诊断：环境=异常；主机匹配=否；主机=${'h'.repeat(100)}`);
  });

  it('关闭的列表页和详情页在预览环境显示诊断', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const list = await render(IndexPage, 'https://wrong.example/articles/live/');
    const detail = await render(DetailPage, 'https://wrong.example/articles/live/alpha/', 'alpha');
    for (const page of [list, detail]) {
      expect(page.response.status).toBe(404);
      expect(page.html).toContain('诊断：环境=preview；主机匹配=否；主机=wrong.example');
    }
  });

  it('生产环境的关闭页面不显示诊断', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    for (const host of [LIVE_PREVIEW_HOST, 'azsou.com']) {
      const list = await render(IndexPage, `https://${host}/articles/live/`);
      const detail = await render(DetailPage, `https://${host}/articles/live/alpha/`, 'alpha');
      for (const page of [list, detail]) {
        expect(page.response.status).toBe(404);
        expect(page.html).not.toContain('诊断');
        expect(page.html).not.toContain('环境=');
      }
    }
  });
});
