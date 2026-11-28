// Which requests may use the pilot article pages. Everything else is a plain 404.
// A preview deployment is recognised by the platform's system variables, not by the request host:
// behind the adapter the host the page sees is not the one the browser asked for.
export const LIVE_PREVIEW_BRANCH = 'feat/sb03-article-draft-pilot';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export type LiveArticleGate = { open: false } | { open: true; target: 'local' | 'test' };

type GateInput = {
  hostname: string;
  dev: boolean;
  vercelEnv: string | undefined;
  gitRef?: string | undefined;
};

export function liveArticleGate(input: GateInput): LiveArticleGate {
  if (input.vercelEnv === 'preview') {
    return input.gitRef === LIVE_PREVIEW_BRANCH ? { open: true, target: 'test' } : { open: false };
  }
  if (input.vercelEnv !== 'production' && input.dev && LOCAL_HOSTS.includes(input.hostname)) {
    return { open: true, target: 'local' };
  }
  return { open: false };
}

// Shown only on closed pilot pages outside production, so a closed gate can be explained from the page itself.
export function liveGateDiagnostic(input: GateInput): string | null {
  if (input.vercelEnv === 'production' || liveArticleGate(input).open) return null;
  const env =
    input.vercelEnv === undefined
      ? '未设置'
      : /^[a-z]{1,20}$/.test(input.vercelEnv)
        ? input.vercelEnv
        : '异常';
  const branch =
    input.gitRef === undefined ? '未设置' : input.gitRef === LIVE_PREVIEW_BRANCH ? '匹配' : '不匹配';
  return `诊断：环境=${env}；分支=${branch}；主机=${input.hostname.slice(0, 100)}`;
}
