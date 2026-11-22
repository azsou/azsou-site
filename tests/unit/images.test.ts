// @vitest-environment jsdom
/**
 * P5 编辑器图片：路径 / URL 白名单 / Markdown 渲染与净化 / Storage 适配器 / 编辑器插入面板。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  altFromFileName,
  checkImageFile,
  cleanAlt,
  fitWithin,
  imageMarkdown,
  objectPath,
  parseImageUrl,
  publicImageUrl,
} from '@/lib/images';
import { renderMarkdown } from '@/lib/markdown';
import { markdownHtml, sanitize } from '@/lib/sanitize';
import { supabaseConfig } from '@/lib/supabase-config';
import {
  createSupabaseRepository,
  ForbiddenError,
  memoryStore,
  NotSignedInError,
  ValidationError,
  type Session,
} from '@/lib/data';
import { storageError } from '@/lib/data/supabase';
import { mountEditor } from '@/scripts/community/editor';
import { imageFromTransfer } from '@/scripts/community/image-upload';

const UID = '00000000-0000-4000-a000-00000000000a';
// 本文件按「测试项目构建」校验（https）；本机栈的 http 例外在最后一组单独测
const TEST_BASE = 'https://ovvfwkmqlejcpatmfqcd.supabase.co';
const LOCAL_BASE = 'http://127.0.0.1:54321';
beforeEach(() => {
  vi.stubEnv('PUBLIC_SUPABASE_URL', TEST_BASE);
  vi.stubEnv('PUBLIC_SUPABASE_KEY', 'sb_publishable_test');
});
afterEach(() => vi.unstubAllEnvs());
const HOST = new URL(TEST_BASE).host;
const good = `https://${HOST}/storage/v1/object/public/ugc-images/${UID}/202610-abc123def456-800x600.webp`;

describe('images：限制与路径', () => {
  it('checkImageFile：类型与大小', () => {
    expect(checkImageFile('image/png', 1000)).toBeNull();
    expect(checkImageFile('image/svg+xml', 1000)).toContain('只支持');
    expect(checkImageFile('image/heic', 1000)).toContain('只支持');
    expect(checkImageFile('image/jpeg', 21 * 1024 * 1024)).toContain('20 MB');
    expect(checkImageFile('image/gif', 0)).toContain('空');
  });
  it('fitWithin 等比缩放、不放大', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 4000)).toEqual({ width: 400, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });
  it('objectPath 符合 0010 RLS 的路径规则', () => {
    const p = objectPath(
      UID,
      { width: 800, height: 600, ext: 'webp' },
      'AbC-12_3dEf456xyz',
      new Date('2026-10-24T00:00:00Z'),
    );
    expect(p).toBe(`${UID}/202610-abc123def456-800x600.webp`);
    expect(p).toMatch(new RegExp(`^${UID}/[a-z0-9][a-z0-9-]{0,79}\\.(webp|png|jpg|jpeg|gif)$`));
    expect(publicImageUrl(p, 'https://x.supabase.co/')).toBe(
      `https://x.supabase.co/storage/v1/object/public/ugc-images/${p}`,
    );
  });
  it('parseImageUrl：只接受本站桶的规范 https 地址，并读出宽高', () => {
    expect(parseImageUrl(good)).toEqual({ url: good, width: 800, height: 600 });
    const bad = [
      good.replace('https:', 'http:'),
      good.replace(HOST, 'evil.example.com'),
      good.replace('/public/', '/sign/'),
      good.replace('ugc-images', 'other'),
      good + '?x=1',
      good + '#a',
      good.replace('.webp', '.svg'),
      good.replace(UID, '../x'),
      `https://user:pw@${HOST}/storage/v1/object/public/ugc-images/${UID}/a.webp`,
      'javascript:alert(1)',
      'not a url',
    ];
    for (const b of bad) expect(parseImageUrl(b), b).toBeNull();
    expect(parseImageUrl(good.replace('-800x600', ''))).toEqual({ url: good.replace('-800x600', '') });
  });
  it('parseImageUrl：http 只在构建指向本机栈时、且只限该本机源', () => {
    const path = `/storage/v1/object/public/ugc-images/${UID}/202610-abc123def456-800x600.webp`;
    // 测试项目构建：本机 http 地址不接受
    expect(parseImageUrl(`${LOCAL_BASE}${path}`)).toBeNull();
    vi.stubEnv('PUBLIC_SUPABASE_URL', LOCAL_BASE);
    expect(supabaseConfig().url).toBe(LOCAL_BASE);
    expect(parseImageUrl(`${LOCAL_BASE}${path}`)).toEqual({
      url: `${LOCAL_BASE}${path}`,
      width: 800,
      height: 600,
    });
    // 别的端口 / 别的 loopback 名字 / 测试项目主机都不行
    expect(parseImageUrl(`http://127.0.0.1:9999${path}`)).toBeNull();
    expect(parseImageUrl(`http://localhost:54321${path}`)).toBeNull();
    expect(parseImageUrl(`${TEST_BASE}${path}`)).toBeNull();
  });
  it('替代文字：清洗与默认值', () => {
    expect(cleanAlt(' a [b]\nc ')).toBe('a b c');
    expect([...cleanAlt('长'.repeat(200))].length).toBe(120);
    expect(imageMarkdown('', good)).toBe(`![图片](${good})`);
    expect(imageMarkdown('截图 [1]', good)).toBe(`![截图 1](${good})`);
    expect(altFromFileName('时间轴面板.png')).toBe('时间轴面板');
    expect(altFromFileName('IMG_1234.JPG')).toBe('');
    expect(altFromFileName('image.png')).toBe('');
    expect(altFromFileName('Screenshot 2026-10-24.png')).toBe('');
    expect(altFromFileName('ember_deep-boss.webp')).toBe('ember deep boss');
  });
});

describe('Markdown 图片', () => {
  it('本站图片渲染为 <img>（懒加载、宽高、替代文字已转义）', () => {
    const html = renderMarkdown(`看图：![a "b" <c>](${good})`);
    expect(html).toContain(
      `<img src="${good}" alt="a &quot;b&quot; &lt;c&gt;" width="800" height="600" loading="lazy" decoding="async">`,
    );
  });
  it('外链图片退化为链接；危险地址只剩文字', () => {
    expect(renderMarkdown('![x](https://evil.example.com/a.png)')).toBe(
      '<p><a href="https://evil.example.com/a.png" rel="nofollow ugc noopener">x</a></p>',
    );
    expect(renderMarkdown('![x](javascript:alert(1))')).not.toContain('javascript');
    expect(renderMarkdown('![](https://evil.example.com/a.png)')).toContain('>图片</a>');
  });
  it('净化后保留合法图片；原始 HTML 的 <img> 仍是文字；DOMPurify 移除非白名单图片', () => {
    const ok = markdownHtml(`![截图](${good})`);
    expect(ok).toContain('<img');
    expect(ok).toContain('alt="截图"');
    expect(ok).toContain('loading="lazy"');
    expect(ok).toContain('width="800" height="600"');
    const raw = markdownHtml(`<img src=x onerror=alert(1)>`);
    expect(raw).not.toContain('<img');
    // 绕过渲染器、直接给净化器一段 HTML：外链 / 事件属性都被去掉
    const s = sanitize(
      `<p><img src="https://evil.example.com/a.png" alt="x"><img src="${good}" onerror="alert(1)" width="99999" alt="ok"></p>`,
    );
    expect(s).not.toContain('evil.example.com');
    expect(s).not.toContain('onerror');
    expect(s).not.toContain('99999');
    expect(s).toContain('alt="ok"');
  });
});

describe('Storage 适配器', () => {
  const session: Session = {
    accessToken: 'jwt-1',
    refreshToken: 'r',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: UID, email: 'a@example.com', emailConfirmed: true, provider: 'email', metaName: 'A' },
  };
  const make = (respond: (url: string, init: RequestInit) => Response, s: Session | null = session) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.fn(async (u: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(u), init });
      return respond(String(u), init);
    });
    const repo = createSupabaseRepository({
      url: 'https://x.supabase.co',
      key: 'pk',
      fetch: f as unknown as typeof fetch,
      store: memoryStore(s),
    });
    return { repo, calls };
  };
  it('上传：POST 到自己的目录，带 JWT、类型、x-upsert:false；返回公开 URL', async () => {
    const { repo, calls } = make(() => new Response('{"Key":"ugc-images/x"}', { status: 200 }));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const r = await repo.media!.uploadImage(blob, { width: 640, height: 480, ext: 'webp' });
    expect(r.path).toMatch(new RegExp(`^${UID}/\\d{6}-[a-z0-9]{6,12}-640x480\\.webp$`));
    expect(r.url).toBe(`https://x.supabase.co/storage/v1/object/public/ugc-images/${r.path}`);
    expect(calls[0].url).toBe(`https://x.supabase.co/storage/v1/object/ugc-images/${r.path}`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer jwt-1',
      apikey: 'pk',
      'content-type': 'image/webp',
      'x-upsert': 'false',
    });
    expect(new Uint8Array(calls[0].init.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('未登录不发请求', async () => {
    const { repo, calls } = make(() => new Response('{}'), null);
    await expect(
      repo.media!.uploadImage(new Blob(['x'], { type: 'image/png' }), { width: 1, height: 1, ext: 'png' }),
    ).rejects.toBeInstanceOf(NotSignedInError);
    expect(calls).toHaveLength(0);
  });
  it('删除：路径校验 + DELETE', async () => {
    const { repo, calls } = make(() => new Response('{}', { status: 200 }));
    await repo.media!.deleteImage(`${UID}/a-1x1.webp`);
    expect(calls[0]).toMatchObject({ init: { method: 'DELETE' } });
    await expect(repo.media!.deleteImage('../etc/passwd')).rejects.toBeInstanceOf(ValidationError);
  });
  it('错误翻译成中文', () => {
    expect(
      storageError(413, { statusCode: '413', message: 'The object exceeded the maximum allowed size' })
        .message,
    ).toContain('2 MB');
    expect(
      storageError(400, { statusCode: '415', message: 'mime type image/svg+xml is not supported' }).message,
    ).toContain('只支持');
    const rls = storageError(400, {
      statusCode: '403',
      error: 'Unauthorized',
      message: 'new row violates row-level security policy',
    });
    expect(rls).toBeInstanceOf(ForbiddenError);
    expect(rls.message).toContain('10 分钟最多 10 张');
    expect(storageError(401, { message: 'jwt expired' })).toBeInstanceOf(NotSignedInError);
    expect(storageError(404, { message: 'Bucket not found' }).message).toContain('ugc-images');
  });
});

describe('编辑器图片面板', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());
  const setup = (upload: (f: Blob) => Promise<{ url: string }>) => {
    const form = document.createElement('form');
    const t = document.createElement('textarea');
    form.append(t);
    document.body.append(form);
    const submit = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submit);
    const ed = mountEditor(t, { limit: [1, 5000], label: '正文', images: { upload } });
    const panel = ed.root.querySelector<HTMLElement>('[data-image-panel]')!;
    const input = ed.root.querySelector<HTMLInputElement>('[data-image-input]')!;
    return { t, ed, panel, input, submit };
  };
  const png = (name = '面板截图.png', type = 'image/png') =>
    new File([new Uint8Array([137, 80, 78, 71])], name, { type });
  const choose = (input: HTMLInputElement, f: File) => {
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    input.dispatchEvent(new Event('change'));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('工具栏有「插入图片」按钮；images:false 时没有', () => {
    const { ed } = setup(async () => ({ url: good }));
    expect(ed.root.querySelector('[data-tool="image"] .visually-hidden')!.textContent).toBe('插入图片');
    const t2 = document.createElement('textarea');
    document.body.append(t2);
    const ed2 = mountEditor(t2, { limit: [1, 10], label: 'x', images: false });
    expect(ed2.root.querySelector('[data-tool="image"]')).toBeNull();
  });
  it('选择文件 → 上传 → 填说明 → 插入到原光标处（独占一行）', async () => {
    const upload = vi.fn(async () => ({ url: good }));
    const { t, panel, input } = setup(upload);
    t.value = '第一段文字';
    t.setSelectionRange(5, 5);
    choose(input, png());
    expect(panel.hidden).toBe(false);
    const alt = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(alt.value).toBe('面板截图');
    expect(document.activeElement).toBe(alt);
    await flush();
    expect(panel.textContent).toContain('上传完成');
    alt.value = '时间轴';
    panel.querySelector<HTMLButtonElement>('.btn--primary')!.click();
    await flush();
    expect(t.value).toBe(`第一段文字\n![时间轴](${good})\n`);
    expect(panel.hidden).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('在说明框按回车插入，而不是提交外层表单；Esc 取消', async () => {
    const { t, panel, input, submit } = setup(async () => ({ url: good }));
    choose(input, png());
    const alt = panel.querySelector<HTMLInputElement>('input[type="text"]')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    alt.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await flush();
    await flush();
    expect(t.value).toContain('![面板截图]');
    expect(submit).not.toHaveBeenCalled();
    choose(input, png());
    alt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(panel.hidden).toBe(true);
  });
  it('不支持的类型直接提示；上传失败显示中文原因且不插入', async () => {
    const { t, panel, input } = setup(async () => {
      throw new ForbiddenError('无法上传：账户受限');
    });
    choose(input, png('a.svg', 'image/svg+xml'));
    expect(panel.dataset.state).toBe('error');
    expect(panel.textContent).toContain('只支持');
    choose(input, png());
    await flush();
    expect(panel.dataset.state).toBe('error');
    expect(panel.textContent).toContain('图片上传失败：无法上传：账户受限');
    expect(t.value).toBe('');
  });
  it('粘贴图片触发上传；粘贴文字不受影响', async () => {
    const upload = vi.fn(async () => ({ url: good }));
    const { t, panel } = setup(upload);
    const ev = new Event('paste', { cancelable: true, bubbles: true }) as ClipboardEvent;
    const f = png('image.png');
    Object.defineProperty(ev, 'clipboardData', { value: { files: [f], items: [], types: ['Files'] } });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(upload).toHaveBeenCalledWith(f);
    const text = new Event('paste', { cancelable: true, bubbles: true }) as ClipboardEvent;
    Object.defineProperty(text, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'] } });
    t.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });
  it('imageFromTransfer：从 files 或 items 里取第一张图', () => {
    const f = png();
    expect(
      imageFromTransfer({
        files: [new File(['x'], 'a.txt', { type: 'text/plain' }), f],
        items: [],
      } as unknown as DataTransfer),
    ).toBe(f);
    expect(
      imageFromTransfer({
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => f }],
      } as unknown as DataTransfer),
    ).toBe(f);
    expect(imageFromTransfer(null)).toBeNull();
  });
});
