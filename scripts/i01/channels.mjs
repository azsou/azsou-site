// I01 真实验收的两条通道（第七轮 I01，站长 2026-10-29）。
//
// 为什么要分开：沙箱 / 运行环境的出口代理会按主机名往请求里**注入凭据**，而且会**覆盖**请求自带的同名头
// （2026-10-29 实测：azsou-test 项目主机上有一个来源不明的 Authorization 注入，手动带的 Authorization 也被替换——
// docs/audits/evidence/sbtest/credential-binding-2026-10-29.md）。如果用户 / anon / 被封禁用户 / RLS 验收也经这个代理发出，
// 它们会悄悄变成 service_role 请求，验收结果全部失真。
//
//  - 用户验收通道 userChannel：只允许 azsou-test 项目主机、预览站、收件箱三个源；用 node:http(s) **直连**（不读任何 *_PROXY 环境变量、
//    不经全局 fetch，所以 NODE_USE_ENV_PROXY=1 也影响不到它）；请求头只能是 anon key 与用户自己的 JWT——带 service_role JWT、
//    sb_secret_ 密钥或与 anon key 不同的 apikey → 直接拒绝（ChannelViolation）。第一次真正发请求之前做一次只读金丝雀：
//    只带 anon key 读 GET /auth/v1/admin/users?per_page=1，必须 401 / 403；2xx = 有 service_role 被注入进了用户通道 → ChannelPolluted，整个验收停止。
//  - 管理通道 adminChannel：只允许 api.github.com 与 api.vercel.com（部署映射 / 分支头只读查询），可以走注入；
//    拒绝 azsou-test 项目主机与预览站，避免管理凭据混进用户验收。
// 两条通道都不跟随重定向（redirect: 'manual'）。
import http from 'node:http';
import https from 'node:https';

export class ChannelViolation extends Error {}
export class ChannelPolluted extends Error {}

export const ADMIN_HOSTS = Object.freeze(['api.github.com', 'api.vercel.com']);

/** 直连 fetch：node:http(s)，不用代理、不跟随重定向；返回标准 Response */
export function directFetch(url, init = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
  if (!mod) return Promise.reject(new ChannelViolation(`不支持的协议 ${u.protocol}`));
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        // 显式不用任何代理 agent：每个请求一个新连接
        agent: false,
        timeout: init.timeoutMs ?? 60_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = new globalThis.Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
          const status = res.statusCode ?? 0;
          const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('client-timeout')));
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}

/** 解码 JWT 载荷（不验签）；不是 JWT → null */
export function jwtPayload(token) {
  const p = String(token ?? '').split('.');
  if (p.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const headerMap = (h) =>
  Object.fromEntries(
    Object.entries(h instanceof globalThis.Headers ? Object.fromEntries(h.entries()) : (h ?? {})).map(
      ([k, v]) => [k.toLowerCase(), String(v)],
    ),
  );

/**
 * 用户验收通道。
 * @param {{ sbOrigin: string, siteOrigin: string, inboxOrigin?: string, anonKey: string,
 *   transport?: (url: string, init: any) => Promise<Response>, canary?: boolean }} o
 */
export function userChannel({
  sbOrigin,
  siteOrigin,
  inboxOrigin = '',
  anonKey,
  transport = directFetch,
  canary = true,
}) {
  const allowed = new Set([sbOrigin, siteOrigin, inboxOrigin].filter(Boolean).map((x) => new URL(x).origin));
  const sb = new URL(sbOrigin).origin;
  let canaryDone = !canary;
  const log = [];
  const check = (url, h) => {
    const u = new URL(url);
    if (!allowed.has(u.origin))
      throw new ChannelViolation(`用户通道拒绝主机 ${u.host}（只允许测试项目、预览站、收件箱）`);
    if (ADMIN_HOSTS.includes(u.hostname)) throw new ChannelViolation(`用户通道不能访问管理主机 ${u.host}`);
    const apikey = h.apikey;
    if (apikey !== undefined) {
      if (/^sb_secret_/.test(apikey)) throw new ChannelViolation('用户通道拒绝 sb_secret_ 密钥');
      if (u.origin === sb && apikey !== anonKey)
        throw new ChannelViolation('用户通道的 apikey 只能是 anon / publishable key');
      if (jwtPayload(apikey)?.role === 'service_role')
        throw new ChannelViolation('用户通道拒绝 service_role 作为 apikey');
    }
    const auth = h.authorization;
    if (auth !== undefined && u.origin === sb) {
      const tok = auth.replace(/^Bearer\s+/i, '');
      if (jwtPayload(tok)?.role === 'service_role')
        throw new ChannelViolation('用户通道拒绝 service_role 的 Authorization');
      if (/^sb_secret_/.test(tok)) throw new ChannelViolation('用户通道拒绝 sb_secret_ 密钥');
    }
  };
  const raw = async (url, init = {}) => {
    const h = headerMap(init.headers);
    check(url, h);
    const r = await transport(url, { ...init, headers: h, redirect: 'manual' });
    log.push({ host: new URL(url).host, path: new URL(url).pathname, status: r.status });
    return r;
  };
  const runCanary = async () => {
    const r = await raw(`${sb}/auth/v1/admin/users?per_page=1`, { headers: { apikey: anonKey } });
    if (r.status >= 200 && r.status < 300)
      throw new ChannelPolluted(
        `用户通道金丝雀：只带 anon key 读 Auth Admin 列用户返回 ${r.status}——有 service_role 被注入进了用户通道，验收全部停止`,
      );
    if (r.status !== 401 && r.status !== 403)
      throw new ChannelPolluted(
        `用户通道金丝雀返回 ${r.status}（期望 401 / 403），无法确认通道干净，验收停止`,
      );
    return r.status;
  };
  const fetchUser = async (url, init = {}) => {
    if (!canaryDone) {
      canaryDone = true;
      await runCanary();
    }
    return raw(url, init);
  };
  return Object.assign(fetchUser, { kind: 'user', log, runCanary });
}

/** 管理通道：只读 GitHub / Vercel；拒绝测试项目与预览站 */
export function adminChannel({ transport = fetch, forbidOrigins = [] } = {}) {
  const forbid = new Set(forbidOrigins.filter(Boolean).map((x) => new URL(x).origin));
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    if (!ADMIN_HOSTS.includes(u.hostname))
      throw new ChannelViolation(`管理通道只允许 ${ADMIN_HOSTS.join(' / ')}，拒绝 ${u.host}`);
    if (forbid.has(u.origin)) throw new ChannelViolation(`管理通道拒绝 ${u.host}`);
    if ((init.method ?? 'GET') !== 'GET') throw new ChannelViolation('管理通道只允许只读 GET');
    return transport(url, { ...init, redirect: 'manual' });
  };
  return Object.assign(fn, { kind: 'admin' });
}
