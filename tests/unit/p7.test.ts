/**
 * P7 第一批（T7.1–T7.5）：搜索合并 / 摘要、标签汇总与登记、留言与友链输入规则、提交 Function、
 * 主题偏好、作者账号（只显示核实过的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { excerptParts, mergeHits, normalizeUrl, type SearchItem } from '@/lib/search';
import { aggregateTags, TAGS, tagDescription, tagWeight, typeSummary, type TaggedItem } from '@/lib/tags';
import { checkGuestbook, checkLink, normalizeSiteUrl, ticketPayload } from '@/lib/community-forms';
import {
  clientHash,
  COMMUNITY_TEST_SECRET,
  handleCommunitySubmit,
  makeCommunityTicket,
  resolveTicketSecret,
} from '@/lib/server/community-submit';
import { isThemePref, nextTheme, readTheme } from '@/scripts/theme';
import { ALL_SOCIAL, SOCIAL, sameAs } from '@/lib/social';
import { person } from '@/lib/seo';

const root = path.resolve(__dirname, '../..');

// ------------------------------------------------------------------ T7.1 ----
describe('T7.1 搜索：Pagefind 与站内索引合并', () => {
  const items: SearchItem[] = [
    {
      type: 'app',
      title: '单文件工具箱',
      url: '/apps/single-file-toolbox/',
      pinyin: 'dwjgjx',
      meta: '效率工具',
    },
    {
      type: 'article',
      title: '拼音首字母搜索',
      url: '/articles/pinyin/',
      summary: '单文件工具箱的拼音 dwjgjx',
    },
  ];
  it('摘要只保留文字与 <mark>，HTML 实体解码、其余标签当文字剥掉', () => {
    expect(excerptParts('前 <mark>塔防</mark> 后 &amp; &lt;b&gt; <img src=x onerror=1>')).toEqual([
      { text: '前 ', mark: false },
      { text: '塔防', mark: true },
      { text: ' 后 & <b> ', mark: false },
    ]);
    expect(excerptParts('&#x4e2d;&#25991;')).toEqual([{ text: '中文', mark: false }]);
  });
  it('拼音强命中排最前，Pagefind 结果去重并把摘要补到已有条目上', () => {
    const pf = [
      {
        type: 'article' as const,
        title: '拼音首字母搜索',
        url: '/articles/pinyin/index.html',
        sub: '',
        excerpt: [{ text: 'x', mark: true }],
      },
      { type: 'video' as const, title: '别的视频', url: '/videos/v/', sub: '' },
    ];
    const out = mergeHits(items, 'dwjgjx', pf);
    expect(out.map((h) => h.url)).toEqual([
      '/apps/single-file-toolbox/',
      '/articles/pinyin/index.html',
      '/videos/v/',
    ]);
    const merged = mergeHits(items, '拼音首字母', pf);
    expect(merged[0].url).toBe('/articles/pinyin/');
    expect(merged[0].excerpt).toEqual([{ text: 'x', mark: true }]);
    expect(merged.filter((h) => normalizeUrl(h.url) === '/articles/pinyin/')).toHaveLength(1);
  });
  it('只索引内容详情页（Base.astro 的 searchType），Pagefind 只在构建后运行', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('scripts/pagefind.mjs');
    for (const p of ['apps', 'ai', 'videos', 'games', 'articles', 'works'])
      expect(fs.readFileSync(path.join(root, `src/pages/${p}/[slug].astro`), 'utf8'), p).toMatch(
        /searchType="/,
      );
    expect(fs.readFileSync(path.join(root, 'src/pages/forum/t/[id].astro'), 'utf8')).toContain(
      'searchType="thread"',
    );
  });
  it('CSP：只有 /pagefind/ 的 Worker 带 wasm-unsafe-eval，页面 CSP 不带', () => {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const csp = (src: string) =>
      v.headers
        .find((h: { source: string }) => h.source === src)
        .headers.find((x: { key: string }) => x.key === 'Content-Security-Policy').value as string;
    expect(csp('/pagefind/(.*)')).toContain("'wasm-unsafe-eval'");
    expect(csp('/((?!_astro/|pagefind/).*)')).not.toContain('wasm');
    expect(new RegExp('^/((?!_astro/|pagefind/).*)$').test('/pagefind/pagefind-worker.js')).toBe(false);
  });
});

// ------------------------------------------------------------------ T7.2 ----
describe('T7.2 标签', () => {
  const it3 = (type: TaggedItem['type'], title: string, tags: string[]): TaggedItem => ({
    type,
    title,
    url: `/${type}/${title}/`,
    summary: '',
    tags,
  });
  it('数量是真实条目数（同一条目重复的标签只算一次），按数量排序，分类型统计', () => {
    const tags = aggregateTags([
      it3('app', 'a', ['mcp', 'mcp']),
      it3('tool', 'b', ['mcp', 'open-source']),
      it3('video', 'c', ['mcp']),
    ]);
    expect(tags.map((t) => [t.slug, t.count])).toEqual([
      ['mcp', 3],
      ['open-source', 1],
    ]);
    expect(tags[0].byType).toEqual({ app: 1, tool: 1, video: 1 });
    expect(typeSummary(tags[0].byType)).toBe('1 个应用 · 1 个AI 工具 · 1 个视频');
    expect(tags[0].weight).toBe(5);
    expect(tags[1].weight).toBe(1);
  });
  it('字号分档 1–5，单调不减', () => {
    let prev = 0;
    for (let n = 1; n <= 10; n++) {
      const w = tagWeight(n, 10);
      expect(w).toBeGreaterThanOrEqual(prev);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(5);
      prev = w;
    }
    expect(tagWeight(10, 10)).toBe(5);
  });
  it('内容里用到的每个标签都在 src/lib/tags.ts 登记了中文 / 品牌显示名', () => {
    const used = new Set<string>();
    for (const dir of ['apps', 'tools', 'videos', 'articles']) {
      const d = path.join(root, 'src/content', dir);
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) {
        const fm = fs.readFileSync(path.join(d, f), 'utf8').split(/^---$/m)[1];
        for (const t of JSON.parse(fm).tags ?? []) used.add(t);
      }
    }
    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((t) => !TAGS[t])).toEqual([]);
    expect(tagDescription('mcp', 6)).toMatch(/共 6 个条目。$/);
  });
});

// ------------------------------------------------------------- T7.3 / T7.4 ----
describe('T7.3 / T7.4 输入规则（与 0015 一致）', () => {
  it('留言：昵称 1–24、正文 1–500、控制字符、链接数量', () => {
    expect(checkGuestbook({ nickname: ' 路人 ', body: ' 你好\r\n世界 ' })).toEqual({
      ok: true,
      value: { nickname: '路人', body: '你好\n世界' },
    });
    expect(checkGuestbook({ nickname: '', body: 'x' })).toMatchObject({ ok: false, field: 'nickname' });
    expect(checkGuestbook({ nickname: '名'.repeat(25), body: 'x' })).toMatchObject({
      ok: false,
      field: 'nickname',
    });
    expect(checkGuestbook({ nickname: 'a\u0007', body: 'x' })).toMatchObject({ ok: false });
    expect(checkGuestbook({ nickname: 'a', body: '字'.repeat(501) })).toMatchObject({
      ok: false,
      field: 'body',
    });
    expect(checkGuestbook({ nickname: 'a', body: 'http://a https://b https://c' })).toMatchObject({
      ok: false,
    });
    expect(checkGuestbook({ nickname: 1, body: {} })).toMatchObject({ ok: false });
  });
  it('友链：只收 https，主机名规范化成小写，去掉片段；拒绝账号密码', () => {
    expect(normalizeSiteUrl('https://Blog.Example.com/a#x')).toBe('https://blog.example.com/a');
    expect(normalizeSiteUrl('http://example.com')).toBeNull();
    expect(normalizeSiteUrl('https://u:p@example.com')).toBeNull();
    expect(normalizeSiteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSiteUrl('https://localhost')).toBeNull();
    expect(checkLink({ name: '站', url: 'https://a.com', description: '', contact: '' })).toMatchObject({
      ok: true,
    });
    expect(checkLink({ name: '', url: 'https://a.com' })).toMatchObject({ ok: false, field: 'name' });
  });
  it('票据：与 SQL 同一算法（kind|ts|client|sha256(payload)）', () => {
    const payload = ticketPayload('guestbook', { nickname: '甲', body: '乙' });
    expect(payload).toBe('甲\n乙');
    const t = makeCommunityTicket('s', 'guestbook', payload, 'c'.repeat(32), 1_800_000_000);
    const digest = createHash('sha256').update('甲\n乙', 'utf8').digest('hex');
    const sig = createHmac('sha256', 's')
      .update(`guestbook|1800000000|${'c'.repeat(32)}|${digest}`)
      .digest('hex');
    expect(t).toBe(`1800000000.${'c'.repeat(32)}.${sig}`);
    expect(clientHash('s', '1.2.3.4')).toMatch(/^[0-9a-f]{32}$/);
    expect(clientHash('s', '1.2.3.4')).not.toBe(clientHash('s', '1.2.3.5'));
  });
  it('部署环境缺少票据密钥时拒绝服务；本地用测试密钥', () => {
    expect(resolveTicketSecret({ VERCEL_ENV: 'production' })).toBeNull();
    expect(resolveTicketSecret({ VERCEL_ENV: 'preview' })).toBeNull();
    expect(resolveTicketSecret({})).toBe(COMMUNITY_TEST_SECRET);
    expect(resolveTicketSecret({ COMMUNITY_TICKET_SECRET: 'x', VERCEL_ENV: 'production' })).toBe('x');
  });
});

describe('/api/submit/[kind]', () => {
  const defaults = { url: 'https://db.example.supabase.co', key: 'pk' };
  const req = (body: unknown, init: { origin?: string; method?: string } = {}) =>
    new Request('https://azsou.com/api/submit/guestbook', {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.origin ? { origin: init.origin } : {}) },
      body: init.method === 'GET' ? undefined : JSON.stringify(body),
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
  const ok = { nickname: '甲', body: '你好', captchaToken: 'tok' };

  it('校验通过 → Turnstile → 带票据调用 guestbook_submit', async () => {
    const m = mk({ status: 200, body: { id: 'x', status: 'pending' } });
    const r = await handleCommunitySubmit(
      'guestbook',
      req(ok),
      {},
      { fetch: m.f, defaults, now: () => 1_800_000_000_000 },
      '9.9.9.9',
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: 'pending' });
    expect(m.calls[0].url).toBe('https://db.example.supabase.co/rest/v1/rpc/guestbook_submit');
    const t = String(m.calls[0].body.p_ticket);
    expect(t).toBe(
      makeCommunityTicket(
        COMMUNITY_TEST_SECRET,
        'guestbook',
        '甲\n你好',
        clientHash(COMMUNITY_TEST_SECRET, '9.9.9.9'),
        1_800_000_000,
      ),
    );
    expect(JSON.stringify(m.calls[0].body)).not.toContain('9.9.9.9');
  });
  it('未知 kind 404、非 POST 405、跨站 403、校验失败 400（带字段）、缺 token / Turnstile 失败 400', async () => {
    const m = mk({ status: 200, body: {} });
    const d = { fetch: m.f, defaults };
    expect((await handleCommunitySubmit('x', req(ok), {}, d)).status).toBe(404);
    expect((await handleCommunitySubmit('guestbook', req(ok, { method: 'GET' }), {}, d)).status).toBe(405);
    expect(
      (await handleCommunitySubmit('guestbook', req(ok, { origin: 'https://evil.example' }), {}, d)).status,
    ).toBe(403);
    const bad = await handleCommunitySubmit('guestbook', req({ ...ok, nickname: '' }), {}, d);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: 'nickname' });
    expect((await handleCommunitySubmit('guestbook', req({ ...ok, captchaToken: '' }), {}, d)).status).toBe(
      400,
    );
    const m2 = mk({ status: 200, body: {} }, false);
    const tf = await handleCommunitySubmit('guestbook', req(ok), {}, { fetch: m2.f, defaults });
    expect(await tf.json()).toMatchObject({ error_code: 'turnstile_failed' });
    expect(m.calls).toHaveLength(0);
    expect(m2.calls).toHaveLength(0);
  });
  it('部署环境没配密钥 → 503，不调用数据库', async () => {
    const m = mk({ status: 200, body: {} });
    const r = await handleCommunitySubmit(
      'guestbook',
      req(ok),
      { VERCEL_ENV: 'production', TURNSTILE_SECRET_KEY: 't' },
      { fetch: m.f, defaults },
    );
    expect(r.status).toBe(503);
    expect(m.calls).toHaveLength(0);
  });
  it('数据库错误映射：限流 429、重复 409、未迁移 503、票据被拒 403', async () => {
    const cases: [unknown, number][] = [
      [{ code: 'PT429', message: 'rate_limited', hint: '提交太频繁，请稍后再试。' }, 429],
      [{ code: '23505', message: '这个网址已经申请过了' }, 409],
      [{ code: 'PGRST202', message: 'x' }, 503],
      [{ code: '42501', message: '提交凭证无效' }, 403],
      [{ code: 'PT503', message: '暂未开放' }, 503],
    ];
    for (const [body, status] of cases) {
      const m = mk({ status: 400, body });
      const r = await handleCommunitySubmit(
        'link',
        req({ name: '站', url: 'https://a.com', captchaToken: 't' }),
        {},
        { fetch: m.f, defaults },
      );
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(m.calls[0].url).toContain('/rpc/friend_link_submit');
    }
  });
});

// ------------------------------------------------------------------ T7.4 ----
describe('T7.4 作者账号', () => {
  it('只显示有地址的账号；没有核实到地址的（B 站 / YouTube）隐藏，不放占位链接', () => {
    expect(SOCIAL.map((a) => a.id)).toEqual(['github', 'rss']);
    for (const a of ALL_SOCIAL) {
      expect(a.verified.length, a.id).toBeGreaterThan(4);
      if (a.url) expect(a.url).toMatch(/^(https:\/\/[^\s]+|\/[^\s]*)$/);
      if (a.url) expect(a.url).not.toMatch(/example|#|todo|placeholder/i);
    }
    expect(ALL_SOCIAL.filter((a) => !a.url).map((a) => a.id)).toEqual(['bilibili', 'youtube']);
  });
  it('Person.sameAs 只有站外账号', () => {
    expect(sameAs()).toEqual(['https://github.com/azsou']);
    expect(person()).toMatchObject({ sameAs: ['https://github.com/azsou'] });
  });
});

// ------------------------------------------------------------------ T7.5 ----
describe('T7.5 主题偏好', () => {
  it('跟随系统 → 浅色 → 深色 → 跟随系统；非法值视为跟随系统', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(readTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(readTheme({ getItem: () => 'purple' })).toBe('system');
    expect(readTheme({ getItem: () => null })).toBe('system');
    expect(
      readTheme({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toBe('system');
    expect(isThemePref('light')).toBe(true);
  });
  it('首帧内联脚本与 theme.ts 使用同一个存储键，并且在 <head> 里（不闪烁）', () => {
    const base = fs.readFileSync(path.join(root, 'src/layouts/Base.astro'), 'utf8');
    const head = base.slice(0, base.indexOf('</head>'));
    expect(head).toContain("localStorage.getItem('az-theme')");
    expect(head).toContain("setAttribute('data-theme'");
    const css = fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8');
    expect(css).toContain(":root:not([data-theme='light'])");
    expect(css).toContain(":root[data-theme='dark']");
  });
});
