/**
 * P7 第二批（T7.6–T7.8）：中英双语路由与文案完整性、Decap CMS 配置与 GitHub OAuth、
 * 订阅源（JSON Feed）、邮件订阅（双重确认、发信抽象、未配置时 503、不存明文令牌）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { alternatesFor, enPathSet, langOf, switchHref, toEn, toZh } from '@/lib/i18n';
import {
  EN_AI_CATEGORY,
  EN_CATEGORY,
  EN_LINK_TYPE,
  EN_PLATFORM,
  EN_PRICE,
  EN_VIDEO_CATEGORY,
} from '@/lib/i18n-labels';
import {
  AI_CATEGORIES,
  CATEGORIES,
  LINK_TYPE_LABEL,
  LINK_TYPES,
  PLATFORM_LABEL,
  PLATFORMS,
  PRICE_LABEL,
  PRICE_MODELS,
  AI_CATEGORY_IDS,
  CATEGORY_IDS,
} from '@/lib/app-store';
import { VIDEO_CATEGORIES } from '@/lib/videos';
import { HUES } from '@/lib/hue';
import { checkSubscribe, subscribePayload, tokenFrom } from '@/lib/subscribe-form';
import { handleSubscribe, unsubscribeToken } from '@/lib/server/subscribe';
import { COMMUNITY_TEST_SECRET, clientHash, makeCommunityTicket } from '@/lib/server/community-submit';
import { createMemoryMailer, createResendMailer, mailerFromEnv } from '@/lib/server/mailer';
import { callbackPage, handleCmsOAuth } from '@/lib/server/cms-oauth';
import { jsonFeed, sortFeed } from '@/lib/feeds';

const root = path.resolve(__dirname, '../..');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function frontmatters(dir: string) {
  const base = path.join(root, 'src/content', dir);
  return fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(base, f), 'utf8');
      return {
        slug: f.replace(/\.md$/, ''),
        data: JSON.parse(raw.split(/^---$/m)[1]) as Record<string, unknown>,
      };
    });
}

// ------------------------------------------------------------------ T7.6 ----
describe('T7.6 路由与 hreflang', () => {
  const set = enPathSet(['/apps/fablemotion/', '/ai/cursor/']);
  it('语言由路径决定，路径互转', () => {
    expect(langOf('/')).toBe('zh');
    expect(langOf('/en/')).toBe('en');
    expect(langOf('/en/ai/cursor/')).toBe('en');
    expect(langOf('/english/')).toBe('zh');
    expect(toEn('/')).toBe('/en/');
    expect(toEn('/apps/x/')).toBe('/en/apps/x/');
    expect(toZh('/en/')).toBe('/');
    expect(toZh('/en/ai/cursor/')).toBe('/ai/cursor/');
  });
  it('只有双方都存在时才有 alternates；切换按钮保留路径，否则去对方首页', () => {
    expect(alternatesFor('/ai/cursor/', set)).toEqual({ zh: '/ai/cursor/', en: '/en/ai/cursor/' });
    expect(alternatesFor('/en/ai/cursor/', set)).toEqual({ zh: '/ai/cursor/', en: '/en/ai/cursor/' });
    expect(alternatesFor('/forum/', set)).toBeNull();
    expect(alternatesFor('/', set)).toEqual({ zh: '/', en: '/en/' });
    expect(switchHref('/forum/', set)).toBe('/en/');
    expect(switchHref('/apps/fablemotion/', set)).toBe('/en/apps/fablemotion/');
    expect(switchHref('/en/videos/', set)).toBe('/videos/');
  });
});

describe('T7.6 英文文案完整、如实', () => {
  it('英文标签覆盖所有中文标签', () => {
    for (const [zh, en] of [
      [PLATFORM_LABEL, EN_PLATFORM],
      [LINK_TYPE_LABEL, EN_LINK_TYPE],
      [CATEGORIES, EN_CATEGORY],
      [AI_CATEGORIES, EN_AI_CATEGORY],
      [PRICE_LABEL, EN_PRICE],
      [VIDEO_CATEGORIES, EN_VIDEO_CATEGORY],
    ] as const)
      expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it.each(['apps', 'tools', 'videos', 'games'])('%s：每个条目都有英文简介，且没有混入中文', (dir) => {
    for (const { slug, data } of frontmatters(dir)) {
      const en = data.en as Record<string, string> | undefined;
      expect(en, `${dir}/${slug} 缺少 en`).toBeTruthy();
      expect(en!.summary.length, `${dir}/${slug}`).toBeGreaterThan(40);
      for (const v of Object.values(en!))
        expect(/[\u4e00-\u9fff]/.test(v), `${dir}/${slug}: ${v}`).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ T7.7 ----
describe('T7.7 Decap CMS 配置', () => {
  const cfg = YAML.parse(fs.readFileSync(path.join(root, 'public/cms/config.yml'), 'utf8'));
  const col = (n: string) => cfg.collections.find((c: { name: string }) => c.name === n);
  const field = (fields: { name: string }[], n: string) =>
    fields.find((f) => f.name === n) as Record<string, unknown>;
  it('GitHub 存储指向 azsou/azsou-site，编辑走 Pull Request，本地模式可用', () => {
    expect(cfg.backend).toMatchObject({
      name: 'github',
      repo: 'azsou/azsou-site',
      branch: 'main',
      auth_endpoint: 'api/cms/auth',
    });
    expect(cfg.publish_mode).toBe('editorial_workflow');
    expect(cfg.local_backend).toBe(true);
  });
  it.each([
    ['apps', 'apps'],
    ['tools', 'tools'],
    ['articles', 'articles'],
  ])('%s：JSON frontmatter 原样读写，内容文件里的每个字段都在配置里（保存时不会丢）', (name, dir) => {
    const c = col(name);
    expect(c).toMatchObject({
      folder: `src/content/${dir}`,
      format: 'json-frontmatter',
      frontmatter_delimiter: '---',
    });
    const declared = new Set(c.fields.map((f: { name: string }) => f.name));
    expect(declared.has('body')).toBe(true);
    for (const { slug, data } of frontmatters(dir))
      for (const k of Object.keys(data)) expect(declared.has(k), `${dir}/${slug}: ${k}`).toBe(true);
  });
  it('下拉选项与 schema 常量一致', () => {
    const apps = col('apps').fields;
    const tools = col('tools').fields;
    const plat = field(apps, 'platforms').fields as { name: string }[];
    expect(field(plat, 'os').options).toEqual([...PLATFORMS]);
    expect(field(plat, 'linkType').options).toEqual([...LINK_TYPES]);
    expect(field(apps, 'category').options).toEqual(CATEGORY_IDS);
    expect(field(tools, 'categories').options).toEqual(AI_CATEGORY_IDS);
    expect(field(apps, 'hue').options).toEqual([...HUES]);
    expect(field(field(apps, 'price').fields as { name: string }[], 'model').options).toEqual([
      ...PRICE_MODELS,
    ]);
  });
  it('/cms/ 有单独的放宽 CSP，全站 CSP 规则不匹配 /cms/ 与 /api/cms/', () => {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const cms = v.headers.find((h: { source: string }) => h.source === '/cms/(.*)');
    const csp = cms.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value as string;
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('https://cdn.jsdelivr.net');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(cms.headers.find((h: { key: string }) => h.key === 'X-Robots-Tag').value).toMatch(/noindex/);
    const site = v.headers.find((h: { source: string }) => h.source.startsWith('/((?!_astro/'));
    const re = new RegExp('^' + site.source + '$');
    expect(re.test('/cms/')).toBe(false);
    expect(re.test('/api/cms/callback')).toBe(false);
    expect(re.test('/apps/')).toBe(true);
    const html = fs.readFileSync(path.join(root, 'public/cms/index.html'), 'utf8');
    expect(html).toMatch(/decap-cms@\d+\.\d+\.\d+\/dist\/decap-cms\.js/);
    expect(html).toMatch(/integrity="sha384-/);
    expect(html).toContain('noindex');
  });
});

describe('T7.7 /api/cms GitHub OAuth', () => {
  const env = { CMS_GITHUB_CLIENT_ID: 'cid', CMS_GITHUB_CLIENT_SECRET: 'sec' };
  const get = (p: string, cookie?: string) =>
    new Request(`https://azsou.com/api/cms/${p}`, { headers: cookie ? { cookie } : {} });
  it('未配置 → 503', async () => {
    expect((await handleCmsOAuth('auth', get('auth'), {})).status).toBe(503);
  });
  it('auth：跳到 GitHub 授权页，state 写进 HttpOnly Cookie', async () => {
    const r = await handleCmsOAuth('auth', get('auth?provider=github&scope=repo'), env);
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://azsou.com/api/cms/callback');
    const state = loc.searchParams.get('state')!;
    expect(r.headers.get('set-cookie')).toContain(`az_cms_state=${state}`);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });
  it('callback：state 不符 → 400，不去换令牌', async () => {
    const f = vi.fn();
    const r = await handleCmsOAuth('callback', get('callback?code=c&state=aaa', 'az_cms_state=bbb'), env, {
      fetch: f as unknown as typeof fetch,
    });
    expect(r.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    expect(await r.text()).toContain('authorization:github:error');
  });
  it('callback：换到令牌 → 页面用 nonce 脚本 postMessage 给同源 opener', async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'gho_</script>x' })),
    ) as unknown as typeof fetch;
    const r = await handleCmsOAuth('callback', get('callback?code=c&state=s1', 'az_cms_state=s1'), env, {
      fetch: f,
    });
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const body = await r.text();
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain('authorization:github:success');
    expect(body).not.toContain('</script>x');
    expect(body).toContain('"https://azsou.com"');
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('callbackPage 只向指定 origin 发消息', () => {
    expect(callbackPage('https://azsou.com', 'n', { token: 't' })).toContain('e.origin!==o');
  });
});

// ------------------------------------------------------------------ T7.8 ----
describe('T7.8 订阅源', () => {
  it('JSON Feed 1.1：绝对地址、日期 ISO、没有日期的不写 date_published', () => {
    const f = JSON.parse(
      jsonFeed({
        site: 'https://azsou.com',
        title: 't',
        description: 'd',
        homePath: '/',
        feedPath: '/feed.json',
        language: 'zh-CN',
        author: { name: 'A', url: 'https://azsou.com/about/' },
        items: sortFeed([
          {
            title: 'old',
            link: '/a/',
            description: 'x',
            pubDate: new Date('2026-01-01T00:00:00Z'),
            categories: [],
          },
          { title: 'nodate', link: '/b/', description: 'y', categories: ['c'] },
          {
            title: 'new',
            link: '/c/',
            description: 'z',
            pubDate: new Date('2026-05-01T00:00:00Z'),
            categories: [],
          },
        ]),
      }),
    );
    expect(f.version).toBe('https://jsonfeed.org/version/1.1');
    expect(f.feed_url).toBe('https://azsou.com/feed.json');
    expect(f.items.map((i: { title: string }) => i.title)).toEqual(['new', 'old', 'nodate']);
    expect(f.items[0].url).toBe('https://azsou.com/c/');
    expect(f.items[2].date_published).toBeUndefined();
  });
});

describe('T7.8 订阅输入规则', () => {
  it('邮箱小写去空白；格式与数据库一致；语言只有 zh / en', () => {
    expect(checkSubscribe({ email: '  Foo.Bar+x@Example.COM ', lang: 'en' })).toEqual({
      ok: true,
      value: { email: 'foo.bar+x@example.com', lang: 'en' },
    });
    expect(checkSubscribe({ email: 'a@b', lang: 'zh' }).ok).toBe(false);
    expect(checkSubscribe({ email: '"a b"@example.com' }).ok).toBe(false);
    expect(checkSubscribe({ email: 'x@example.com', lang: 'fr' })).toMatchObject({
      ok: true,
      value: { lang: 'zh' },
    });
    expect(checkSubscribe({ email: `${'a'.repeat(250)}@example.com` }).ok).toBe(false);
  });
  it('令牌从 #token= 或 ?token= 读取，格式不对返回 null', () => {
    const t = 'a'.repeat(64);
    expect(tokenFrom(`#token=${t}`)).toBe(t);
    expect(tokenFrom('', `?token=${t}`)).toBe(t);
    expect(tokenFrom('#token=abc')).toBeNull();
  });
});

describe('T7.8 发信抽象', () => {
  it('没配置（或缺 EMAIL_FROM）→ null', () => {
    expect(mailerFromEnv({})).toBeNull();
    expect(mailerFromEnv({ RESEND_API_KEY: 'k' })).toBeNull();
    expect(mailerFromEnv({ EMAIL_FROM: 'a@b.c' })).toBeNull();
    expect(mailerFromEnv({ EMAIL_FROM: 'a@b.c', RESEND_API_KEY: 'k' })?.provider).toBe('resend');
    expect(mailerFromEnv({ EMAIL_FROM: 'a@b.c', SMTP_HOST: 'smtp.example.com' })?.provider).toBe('smtp');
    expect(mailerFromEnv({ EMAIL_FROM: 'a@b.c', EMAIL_PROVIDER: 'smtp', RESEND_API_KEY: 'k' })).toBeNull();
  });
  it('Resend：POST /emails，Bearer 密钥，失败抛错', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await createResendMailer('key', 'AZ <a@azsou.com>', f).send({
      to: 'x@y.z',
      subject: 's',
      text: 't',
      html: 'h',
    });
    const [u, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(u).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    expect(JSON.parse(String(init.body))).toMatchObject({ from: 'AZ <a@azsou.com>', to: ['x@y.z'] });
    const bad = vi.fn(async () => new Response('{}', { status: 422 })) as unknown as typeof fetch;
    await expect(
      createResendMailer('k', 'a@b.c', bad).send({ to: 'x', subject: '', text: '', html: '' }),
    ).rejects.toThrow();
  });
});

describe('T7.8 /api/subscribe', () => {
  const defaults = { url: 'https://db.example.supabase.co', key: 'pk' };
  const req = (body: unknown, origin?: string) =>
    new Request('https://azsou.com/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  const mk = (rpc: { status: number; body: unknown }, verify = true) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('siteverify')) return new Response(JSON.stringify({ success: verify }));
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(rpc.body), { status: rpc.status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const ok = { email: 'Reader@Example.com', lang: 'en', captchaToken: 'tok' };

  it('发信服务没配置 → 503，不调数据库也不发信', async () => {
    const m = mk({ status: 200, body: { send: true } });
    const r = await handleSubscribe(req(ok), {}, { fetch: m.f, defaults }, '1.2.3.4');
    expect(r.status).toBe(503);
    expect((await r.json()).error_code).toBe('not_configured');
    expect(m.f).not.toHaveBeenCalled();
  });
  it('部署环境缺 Turnstile / 票据密钥 → 503', async () => {
    const mail = createMemoryMailer();
    const m = mk({ status: 200, body: { send: true } });
    const r = await handleSubscribe(
      req(ok),
      { VERCEL_ENV: 'production' },
      { fetch: m.f, defaults, mailer: mail },
    );
    expect(r.status).toBe(503);
    expect(mail.sent).toHaveLength(0);
  });
  it('格式错误 / 来源不对 / 人机验证失败', async () => {
    const mail = createMemoryMailer();
    const m = mk({ status: 200, body: { send: true } });
    const bad = await handleSubscribe(
      req({ ...ok, email: 'nope' }),
      {},
      { fetch: m.f, defaults, mailer: mail },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe('email');
    expect(
      (await handleSubscribe(req(ok, 'https://evil.example'), {}, { fetch: m.f, defaults, mailer: mail }))
        .status,
    ).toBe(403);
    const v = mk({ status: 200, body: { send: true } }, false);
    expect((await handleSubscribe(req(ok), {}, { fetch: v.f, defaults, mailer: mail })).status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });
  it('成功：数据库只收到令牌的 sha256；确认信里的令牌与之对应；退订令牌可由密钥重算', async () => {
    const mail = createMemoryMailer();
    const m = mk({ status: 200, body: { send: true } });
    const r = await handleSubscribe(
      req(ok),
      {},
      { fetch: m.f, defaults, mailer: mail, now: () => 1_800_000_000_000 },
      '9.9.9.9',
    );
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('check_inbox');
    const body = m.calls[0].body;
    expect(m.calls[0].url).toBe('https://db.example.supabase.co/rest/v1/rpc/subscribe_request');
    expect(body.p_email).toBe('reader@example.com');
    expect(body.p_lang).toBe('en');
    expect(body.p_ticket).toBe(
      makeCommunityTicket(
        COMMUNITY_TEST_SECRET,
        'subscribe',
        subscribePayload({ email: 'reader@example.com', lang: 'en' }),
        clientHash(COMMUNITY_TEST_SECRET, '9.9.9.9'),
        1_800_000_000,
      ),
    );
    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    expect(msg.to).toBe('reader@example.com');
    const confirm = /\/en\/subscribe\/confirm\/#token=([0-9a-f]{64})/.exec(msg.text)![1];
    const unsub = /\/en\/subscribe\/unsubscribe\/#token=([0-9a-f]{64})/.exec(msg.text)![1];
    expect(body.p_confirm_hash).toBe(sha(confirm));
    expect(body.p_unsubscribe_hash).toBe(sha(unsub));
    expect(unsub).toBe(unsubscribeToken(COMMUNITY_TEST_SECRET, 'reader@example.com'));
    expect(JSON.stringify(body)).not.toContain(confirm);
    expect(JSON.stringify(body)).not.toContain(unsub);
    expect(msg.headers?.['List-Unsubscribe']).toContain(unsub);
    expect(msg.html).toContain('https://azsou.com/en/subscribe/confirm/#token=');
  });
  it('已订阅（send = false）：不发信，但回答与新订阅完全相同', async () => {
    const mail = createMemoryMailer();
    const a = await handleSubscribe(
      req(ok),
      {},
      { fetch: mk({ status: 200, body: { send: false } }).f, defaults, mailer: mail },
    );
    const b = await handleSubscribe(
      req(ok),
      {},
      { fetch: mk({ status: 200, body: { send: true } }).f, defaults, mailer: createMemoryMailer() },
    );
    expect(mail.sent).toHaveLength(0);
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });
  it('限流 / 票据被拒 / 发信失败 映射成可读错误', async () => {
    const mail = createMemoryMailer();
    const r429 = await handleSubscribe(
      req(ok),
      {},
      { fetch: mk({ status: 400, body: { code: 'PT429' } }).f, defaults, mailer: mail },
    );
    expect(r429.status).toBe(429);
    const r403 = await handleSubscribe(
      req(ok),
      {},
      { fetch: mk({ status: 403, body: { code: '42501' } }).f, defaults, mailer: mail },
    );
    expect(r403.status).toBe(403);
    const broken = { provider: 'memory' as const, send: async () => Promise.reject(new Error('x')) };
    const r502 = await handleSubscribe(
      req({ ...ok, lang: 'zh' }),
      {},
      { fetch: mk({ status: 200, body: { send: true } }).f, defaults, mailer: broken },
    );
    expect(r502.status).toBe(502);
    expect((await r502.json()).msg).toMatch(/确认邮件发送失败/);
  });
});

describe('T9.15 订阅确认邮件模板 + 一键退订（Q17）', async () => {
  const { confirmationMail, handleOneClickUnsubscribe } = await import('@/lib/server/subscribe');
  const tok = 'a'.repeat(64);
  for (const lang of ['zh', 'en'] as const) {
    it(`${lang}：preheader、品牌头、bulletproof 按钮、深色、退订链接与 List-Unsubscribe-Post`, () => {
      const m = confirmationMail({ origin: 'https://azsou.com', email: 'r@example.com', lang, confirm: 'c1', unsub: tok });
      expect(m.html).toContain('<meta name="color-scheme" content="light dark">');
      expect(m.html).toContain('prefers-color-scheme: dark');
      expect(m.html).toMatch(/display:none;max-height:0[^>]*>[^<]{6,}/); // preheader
      expect(m.html).toMatch(/<td align="center" bgcolor="#[0-9a-f]{6}"[^>]*>\s*<a href="https:\/\/azsou\.com\/(en\/)?subscribe\/confirm\/#token=c1"/);
      expect(m.html).toContain('role="presentation"');
      expect(m.html).toContain(lang === 'en' ? 'lang="en"' : 'lang="zh-CN"');
      expect(m.html).not.toMatch(/<script|javascript:/i);
      expect(m.headers?.['List-Unsubscribe']).toBe(
        `<https://azsou.com/api/unsubscribe?token=${tok}>, <https://azsou.com${lang === 'en' ? '/en' : ''}/subscribe/unsubscribe/#token=${tok}>`,
      );
      expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(m.text).toContain(tok);
    });
  }
  it('一键退订：POST 调 subscribe_unsubscribe；GET 405；令牌格式不对 400', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response('{"status":"unsubscribed"}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const deps = { defaults: { url: 'https://db.example', key: 'anon' }, fetch };
    const ok = await handleOneClickUnsubscribe(
      new Request(`https://azsou.com/api/unsubscribe?token=${tok}`, { method: 'POST', body: 'List-Unsubscribe=One-Click' }),
      {},
      deps,
    );
    expect(ok.status).toBe(200);
    expect(calls[0].url).toBe('https://db.example/rest/v1/rpc/subscribe_unsubscribe');
    expect(JSON.parse(calls[0].body)).toEqual({ p_token: tok });
    expect((await handleOneClickUnsubscribe(new Request('https://azsou.com/api/unsubscribe'), {}, deps)).status).toBe(405);
    expect(
      (await handleOneClickUnsubscribe(new Request('https://azsou.com/api/unsubscribe?token=x', { method: 'POST' }), {}, deps)).status,
    ).toBe(400);
  });
});
