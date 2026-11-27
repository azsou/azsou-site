// Which hosts may serve the pilot article pages. Everything else is a plain 404.
// The preview host is the fixed branch alias of the test deployment, never a production host.
export const LIVE_PREVIEW_HOST = 'azsou-site-git-feat-sb03-article-draft-pilot-azsous-projects.vercel.app';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export type LiveArticleGate = { open: false } | { open: true; target: 'local' | 'test' };

export function liveArticleGate(input: {
  hostname: string;
  dev: boolean;
  vercelEnv: string | undefined;
}): LiveArticleGate {
  if (input.vercelEnv === 'preview' && input.hostname === LIVE_PREVIEW_HOST) {
    return { open: true, target: 'test' };
  }
  if (input.vercelEnv !== 'production' && input.dev && LOCAL_HOSTS.includes(input.hostname)) {
    return { open: true, target: 'local' };
  }
  return { open: false };
}
