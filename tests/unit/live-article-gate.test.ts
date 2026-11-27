import { describe, expect, it } from 'vitest';
import { LIVE_PREVIEW_HOST, liveArticleGate } from '@/lib/data/live-article-gate';

describe('试点页放行规则', () => {
  it('本机开发主机放行，目标是本机库', () => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(liveArticleGate({ hostname, dev: true, vercelEnv: undefined })).toEqual({
        open: true,
        target: 'local',
      });
    }
  });

  it('非开发构建的本机主机、生产环境的本机主机都不放行', () => {
    expect(liveArticleGate({ hostname: '127.0.0.1', dev: false, vercelEnv: undefined })).toEqual({
      open: false,
    });
    expect(liveArticleGate({ hostname: 'localhost', dev: true, vercelEnv: 'production' })).toEqual({
      open: false,
    });
  });

  it('只有固定预览域名且是预览部署才放行，目标是测试库', () => {
    expect(liveArticleGate({ hostname: LIVE_PREVIEW_HOST, dev: false, vercelEnv: 'preview' })).toEqual({
      open: true,
      target: 'test',
    });
    expect(liveArticleGate({ hostname: LIVE_PREVIEW_HOST, dev: true, vercelEnv: 'preview' })).toEqual({
      open: true,
      target: 'test',
    });
  });

  it('固定预览域名在非预览环境不放行', () => {
    for (const vercelEnv of [undefined, 'production', 'development', '', 'Preview']) {
      expect(liveArticleGate({ hostname: LIVE_PREVIEW_HOST, dev: true, vercelEnv })).toEqual({
        open: false,
      });
    }
  });

  it('其它域名一律不放行，包括每次部署的临时域名和相似域名', () => {
    const hosts = [
      'azsou.com',
      'www.azsou.com',
      'azsou-site-abc123-azsous-projects.vercel.app',
      'azsou-site-git-main-azsous-projects.vercel.app',
      `${LIVE_PREVIEW_HOST}.evil.example`,
      `x${LIVE_PREVIEW_HOST}`,
      `evil.example/${LIVE_PREVIEW_HOST}`,
      '',
    ];
    for (const hostname of hosts) {
      for (const vercelEnv of [undefined, 'preview', 'production']) {
        expect(liveArticleGate({ hostname, dev: false, vercelEnv })).toEqual({ open: false });
      }
    }
  });
});
