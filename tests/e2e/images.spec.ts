import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { Resvg } from '@resvg/resvg-js';
import type { Page } from '@playwright/test';
import { test, expect, seedThread, uniq } from './community-fixtures';

/**
 * P5 编辑器图片上传：Storage 接口用 page.route 模拟（本地 / CI 没有 storage-api），
 * 帖子本身写进真实 Postgres（PostgREST + RLS）。存储 RLS 在 tests/db/p5.test.ts 里测。
 */

const SUPA = 'https://abryflgoljltyakthtql.supabase.co';

/** 2400×1200 的 PNG（客户端应缩到 1600×800 并转成 WebP / JPEG） */
function widePng(): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#0a84ff"/><stop offset="1" stop-color="#ff375f"/></linearGradient></defs>
    <rect width="2400" height="1200" fill="url(#g)"/><circle cx="1200" cy="600" r="400" fill="#fff" opacity=".6"/></svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}

interface Upload {
  path: string;
  type: string;
  auth: string;
  upsert: string;
  body: Buffer;
}

/** 模拟 Storage：POST 上传记下内容，GET 公开地址把同一份内容返回 */
async function mockStorage(page: Page, mode: 'ok' | 'rls' = 'ok') {
  const uploads: Upload[] = [];
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(`${SUPA}/storage/v1/object/ugc-images/**`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const path = new URL(req.url()).pathname.replace('/storage/v1/object/ugc-images/', '');
    const h = req.headers();
    if (mode === 'rls')
      return route.fulfill({
        status: 400,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: '403',
          error: 'Unauthorized',
          message: 'new row violates row-level security policy',
        }),
      });
    uploads.push({
      path,
      type: h['content-type'],
      auth: h['authorization'],
      upsert: h['x-upsert'],
      body: req.postDataBuffer() ?? Buffer.alloc(0),
    });
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ Key: `ugc-images/${path}`, Id: randomUUID() }),
    });
  });
  await page.route(`${SUPA}/storage/v1/object/public/ugc-images/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/storage/v1/object/public/ugc-images/', '');
    const u = uploads.find((x) => x.path === path);
    if (!u) return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    await route.fulfill({ status: 200, headers: { ...cors, 'content-type': u.type }, body: u.body });
  });
  return uploads;
}

const IMG_URL = (uid: string) =>
  new RegExp(
    `^${SUPA.replace(/\./g, '\\.')}/storage/v1/object/public/ugc-images/${uid}/\\d{6}-[a-z0-9]{6,12}-1600x800\\.(webp|jpg)$`,
  );

/** 在页面里造一个 File（PNG），供粘贴 / 拖放用 */
async function stageFile(page: Page, b64: string, name: string) {
  await page.evaluate(
    ([data, n]) => {
      const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      (window as unknown as { __file: File }).__file = new File([bin], n, { type: 'image/png' });
    },
    [b64, name] as const,
  );
}

test.describe('编辑器图片上传', () => {
  test('工具栏选图 → 压缩为 1600×800 → 填写替代文字 → 插入 → 发布后主题页显示图片', async ({
    page,
    makeUser,
    signIn,
    errors,
  }) => {
    const uploads = await mockStorage(page);
    const u = await makeUser(uniq('图片作者'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    const title = uniq('带图主题 ');
    await page.getByLabel('标题').fill(title);
    const body = page.locator('#nt-body');
    await body.fill('下面是一张示意图：');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: '插入图片' }).click(),
    ]);
    await chooser.setFiles({ name: 'wide-banner.png', mimeType: 'image/png', buffer: widePng() });
    const panel = page.getByRole('group', { name: '插入图片' });
    await expect(panel).toBeVisible();
    const alt = panel.getByLabel(/图片说明/);
    await expect(alt).toBeFocused();
    await expect(alt).toHaveValue('wide banner');
    await alt.fill('渐变横幅示意图');
    await expect(panel.getByRole('status')).toContainText('上传完成');
    await panel.getByRole('button', { name: '插入到正文' }).click();
    await expect(panel).toBeHidden();

    expect(uploads).toHaveLength(1);
    const up = uploads[0];
    expect(up.path).toMatch(new RegExp(`^${u.id}/\\d{6}-[a-z0-9]{6,12}-1600x800\\.(webp|jpg)$`));
    // Chromium / Firefox 编码 WebP；不支持 WebP 编码的引擎退回 JPEG
    expect(['image/webp', 'image/jpeg']).toContain(up.type);
    expect(up.path.endsWith(up.type === 'image/webp' ? '.webp' : '.jpg')).toBe(true);
    expect(up.body.length).toBeGreaterThan(100);
    expect(up.body.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(up.auth).toBe(`Bearer ${u.token}`);
    expect(up.upsert).toBe('false');

    const value = await body.inputValue();
    const m = /^下面是一张示意图：\n!\[渐变横幅示意图\]\((\S+)\)\n$/.exec(value);
    expect(m, value).not.toBeNull();
    expect(m![1]).toMatch(IMG_URL(u.id));

    const previewBtn = page.getByRole('button', { name: '预览', exact: true });
    if (await previewBtn.isVisible()) await previewBtn.click();
    const pimg = page.getByRole('region', { name: '预览' }).getByRole('img', { name: '渐变横幅示意图' });
    await expect(pimg).toHaveAttribute('width', '1600');
    await expect.poll(() => pimg.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1600);

    await page.getByRole('button', { name: '发布主题' }).click();
    await expect(page).toHaveURL(/\/forum\/t\/\?id=[0-9a-f-]{36}$/);
    await expect(page.locator('h1')).toHaveText(title);
    const img = page.locator('[data-body] img');
    await expect(img).toHaveAttribute('alt', '渐变横幅示意图');
    await expect(img).toHaveAttribute('height', '800');
    await expect(img).toHaveAttribute('loading', 'lazy');
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1600);
    // 图片不超出内容区
    const box = await img.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(errors).toEqual([]);
  });

  test('回复框：粘贴图片与拖入图片都能上传并插入', async ({ page, db, makeUser, signIn, errors }) => {
    const uploads = await mockStorage(page);
    const u = await makeUser(uniq('回复者'));
    const tid = await seedThread(db, u.id, { title: uniq('图片回复 ') });
    await signIn(page, u);
    await page.goto(`/forum/t/?id=${tid}`);
    const ta = page.getByRole('textbox', { name: '写回复' });
    await expect(ta).toBeVisible();
    await stageFile(page, widePng().toString('base64'), 'image.png');

    // 粘贴
    await ta.focus();
    await ta.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add((window as unknown as { __file: File }).__file);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      el.dispatchEvent(ev);
    });
    const panel = page.getByRole('group', { name: '插入图片' });
    await expect(panel).toBeVisible();
    // 剪贴板图片名是 image.png：不预填说明
    await expect(panel.getByLabel(/图片说明/)).toHaveValue('');
    await panel.getByLabel(/图片说明/).fill('粘贴的图');
    await panel.getByLabel(/图片说明/).press('Enter');
    await expect(panel).toBeHidden();
    await expect(ta).toHaveValue(/^!\[粘贴的图\]\(https:\/\/\S+-1600x800\.(webp|jpg)\)\n$/);

    // 拖放
    await ta.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add((window as unknown as { __file: File }).__file);
      const mk = (type: string) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        return ev;
      };
      el.dispatchEvent(mk('dragover'));
      el.dispatchEvent(mk('drop'));
    });
    await expect(panel).toBeVisible();
    await panel.getByLabel(/图片说明/).fill('拖进来的图');
    await expect(panel.getByRole('status')).toContainText('上传完成');
    await panel.getByRole('button', { name: '插入到正文' }).click();
    await expect(ta).toHaveValue(/!\[粘贴的图\][^\n]+\n!\[拖进来的图\][^\n]+\n$/);
    expect(uploads).toHaveLength(2);

    await page.getByRole('button', { name: '发布回复' }).click();
    const reply = page.locator('[data-replies-section] [data-list] .ugc img');
    await expect(reply).toHaveCount(2);
    await expect(reply.nth(1)).toHaveAttribute('alt', '拖进来的图');
    expect(errors).toEqual([]);
  });

  test('存储拒绝（RLS / 限流）时显示中文原因，正文不插入；不支持的格式直接提示', async ({
    page,
    makeUser,
    signIn,
  }) => {
    await mockStorage(page, 'rls');
    const u = await makeUser(uniq('受限'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    const input = page.locator('[data-image-input]');
    await input.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: widePng() });
    const panel = page.getByRole('group', { name: '插入图片' });
    await expect(panel.getByRole('status')).toContainText('图片上传失败');
    await expect(panel.getByRole('status')).toContainText('10 分钟最多 10 张');
    await expect(panel.getByRole('button', { name: '关闭' })).toBeFocused();
    await expect(page.locator('#nt-body')).toHaveValue('');
    await panel.getByRole('button', { name: '关闭' }).click();
    await expect(panel).toBeHidden();
    await input.setInputFiles({ name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(panel.getByRole('status')).toHaveText('只支持 JPG、PNG、WebP、GIF 图片');
  });

  test('无障碍：图片面板打开时发帖页 axe 无违规', async ({ page, makeUser, signIn }) => {
    await mockStorage(page);
    const u = await makeUser(uniq('无障碍'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    await page.locator('[data-image-input]').setInputFiles({
      name: 'a.png',
      mimeType: 'image/png',
      buffer: widePng(),
    });
    await expect(page.getByRole('group', { name: '插入图片' }).getByRole('status')).toContainText('上传完成');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
      [],
    );
  });
});
