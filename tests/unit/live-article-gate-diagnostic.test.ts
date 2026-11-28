import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_PREVIEW_BRANCH, liveGateDiagnostic } from '@/lib/data/live-article-gate';
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
  it('非生产环境说明环境、分支是否匹配和主机，门开时没有诊断', () => {
    expect(
      liveGateDiagnostic({ hostname: 'wrong.example', dev: false, vercelEnv: 'preview', gitRef: 'main' }),
    ).toBe('诊断：环境=preview；分支=不匹配；主机=wrong.example');
    expect(
      liveGateDiagnostic({ hostname: 'localhost', dev: false, vercelEnv: undefined, gitRef: undefined }),
    ).toBe('诊断：环境=未设置；分支=未设置；主机=localhost');
    expect(
      liveGateDiagnostic({
        hostname: 'x.example',
        dev: false,
        vercelEnv: 'development',
        gitRef: LIVE_PREVIEW_BRANCH,
      }),
    ).toBe('诊断：环境=development；分支=匹配；主机=x.example');
    expect(
      liveGateDiagnostic({
        hostname: 'x.example',
        dev: false,
        vercelEnv: 'preview',
        gitRef: LIVE_PREVIEW_BRANCH,
      }),
    ).toBeNull();
    expect(
      liveGateDiagnostic({ hostname: '127.0.0.1', dev: true, vercelEnv: undefined, gitRef: undefined }),
    ).toBeNull();
  });

  it('诊断不泄露分支名，生产环境从不给诊断，异常环境值和超长主机被截断', () => {
    for (const hostname of ['localhost', 'azsou.com', '127.0.0.1']) {
      expect(
        liveGateDiagnostic({ hostname, dev: true, vercelEnv: 'production', gitRef: LIVE_PREVIEW_BRANCH }),
      ).toBeNull();
    }
    const odd = liveGateDiagnostic({
      hostname: 'h'.repeat(300),
      dev: false,
      vercelEnv: 'Prev iew<x>',
      gitRef: 'secret-branch-name',
    });
    expect(odd).toBe(`诊断：环境=异常；分支=不匹配；主机=${'h'.repeat(100)}`);
    expect(odd).not.toContain('secret-branch-name');
  });

  it('关闭的列表页和详情页在预览环境显示诊断', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'main');
    const list = await render(IndexPage, 'https://wrong.example/articles/live/');
    const detail = await render(DetailPage, 'https://wrong.example/articles/live/alpha/', 'alpha');
    for (const page of [list, detail]) {
      expect(page.response.status).toBe(404);
      expect(page.html).toContain('诊断：环境=preview；分支=不匹配；主机=wrong.example');
    }
  });

  it('生产环境的关闭页面不显示诊断', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', LIVE_PREVIEW_BRANCH);
    for (const host of ['localhost', 'azsou.com']) {
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
