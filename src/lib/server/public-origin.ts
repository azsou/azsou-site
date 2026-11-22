/**
 * 对外公开的站点 origin 与同源检查。
 * Vercel 边缘代理之后，函数看到的 request.url 不一定是浏览器访问的地址（协议是 http，主机也可能不同），
 * 所以对外主机依次取：代理设置的 X-Forwarded-Host、Host、请求地址里的主机。
 * 协议除本地主机（localhost / 127.0.0.1 / [::1]，开发与 CI 用 http）外一律按 https。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const first = (v: string | null) => (v ?? '').split(',')[0].trim();

function originOf(host: string): string | null {
  try {
    const u = new URL(`http://${host}`);
    return LOCAL_HOSTS.has(u.hostname) ? u.origin : `https://${u.host}`;
  } catch {
    return null;
  }
}

/** 候选的对外 origin，按可信度排序：代理头 → Host → 请求地址 */
function candidates(request: Request): string[] {
  const hosts = [first(request.headers.get('x-forwarded-host')), first(request.headers.get('host'))];
  hosts.push(new URL(request.url).host);
  const list = hosts.filter(Boolean).map(originOf);
  return [...new Set(list.filter((o): o is string => o !== null))];
}

export function publicOrigin(request: Request): string {
  return candidates(request)[0] ?? new URL(request.url).origin;
}

export function originAllowed(request: Request, reqOrigin: string): boolean {
  return candidates(request).includes(reqOrigin);
}

const clean = (s: string | null) => (s ?? '-').replace(/[^\w.:/-]/g, '?').slice(0, 80);

/**
 * 临时诊断：同源检查不通过时，把双方看到的值带在提示里（只含请求自己的头，经过清洗，不含密钥）。
 * 定位完成后去掉。
 */
export function originMsg(base: string, request: Request): string {
  const h = request.headers;
  const parts = [
    `origin=${clean(h.get('origin'))}`,
    `xfh=${clean(h.get('x-forwarded-host'))}`,
    `host=${clean(h.get('host'))}`,
    `url=${clean(request.url)}`,
  ];
  return `${base}（${parts.join(' ')}）`;
}
