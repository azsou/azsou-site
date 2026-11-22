/**
 * 对外公开的站点 origin。
 * Vercel 边缘代理之后，函数看到的 request.url 可能是 http://域名，而浏览器发来的 Origin 是 https://域名，
 * 直接用 new URL(request.url).origin 做同源检查会把正常请求误判为跨站。
 * 本地主机（localhost / 127.0.0.1 / [::1]）保持原样（开发与 CI 用 http），其余一律按 https 对外。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function publicOrigin(requestUrl: string): string {
  const u = new URL(requestUrl);
  return LOCAL_HOSTS.has(u.hostname) ? u.origin : `https://${u.host}`;
}
