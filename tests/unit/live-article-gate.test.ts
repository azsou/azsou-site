import { describe, expect, it } from 'vitest';
import { LIVE_PREVIEW_BRANCH, liveArticleGate } from '@/lib/data/live-article-gate';

describe('试点页放行规则', () => {
  it('本机开发主机放行，目标是本机库', () => {
    for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(liveArticleGate({ hostname, dev: true, vercelEnv: undefined, gitRef: undefined })).toEqual({
        open: true,
        target: 'local',
      });
    }
  });

  it('非开发构建的本机主机、生产环境的本机主机都不放行', () => {
    expect(
      liveArticleGate({ hostname: '127.0.0.1', dev: false, vercelEnv: undefined, gitRef: undefined }),
    ).toEqual({
      open: false,
    });
    expect(
      liveArticleGate({ hostname: 'localhost', dev: true, vercelEnv: 'production', gitRef: undefined }),
    ).toEqual({
      open: false,
    });
  });

  it('预览部署且是这个分支才放行，目标是测试库，不看主机', () => {
    for (const hostname of ['localhost', 'preview.example', '']) {
      for (const dev of [false, true]) {
        expect(liveArticleGate({ hostname, dev, vercelEnv: 'preview', gitRef: LIVE_PREVIEW_BRANCH })).toEqual(
          {
            open: true,
            target: 'test',
          },
        );
      }
    }
  });

  it('预览部署但分支不对不放行', () => {
    const refs = [
      undefined,
      '',
      'main',
      `${LIVE_PREVIEW_BRANCH}-2`,
      `${LIVE_PREVIEW_BRANCH}/x`,
      `refs/heads/${LIVE_PREVIEW_BRANCH}`,
      LIVE_PREVIEW_BRANCH.toUpperCase(),
    ];
    for (const gitRef of refs) {
      expect(
        liveArticleGate({ hostname: 'preview.example', dev: false, vercelEnv: 'preview', gitRef }),
      ).toEqual({
        open: false,
      });
    }
  });

  it('分支对但不是预览环境不放行', () => {
    for (const vercelEnv of [undefined, 'production', 'development', '', 'Preview']) {
      expect(
        liveArticleGate({ hostname: 'preview.example', dev: false, vercelEnv, gitRef: LIVE_PREVIEW_BRANCH }),
      ).toEqual({ open: false });
    }
  });
});
