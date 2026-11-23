import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { U } from '../db/fixtures';
import { ADMIN_URL, ROOT, SHIM, migrationFiles, run } from '../db/helpers';
import { BIN, freePort, startPostgrest, tok } from '../db/postgrest';
import { freshDb } from '../db/setup';
import { expect, forwardRest, test, type TestUser } from './community-fixtures';

const editor = '/admin/official/article-draft/';
const readSuffix = '/rest/v1/rpc/az_cms_read_article_draft';
const saveUrl = '**/rest/v1/rpc/az_cms_save_article_draft';
let db: Awaited<ReturnType<typeof freshDb>> | undefined;
let child: ChildProcess | undefined;
let origin: string;

// Browser -> native workbench -> actual local PostgREST -> disposable pilot SQL, never a hosted project.
test.beforeAll(async () => {
  test.setTimeout(60_000);
  test.skip(!/-(desktop|iphone)$/.test(test.info().project.name), 'Only desktop and iPhone viewports');
  if (!BIN || !process.env.E2E_PGRST || !process.env.DATABASE_URL) {
    if (process.env.CI) throw new Error('Article editor E2E needs the CI loopback database and PostgREST');
    test.skip(true, 'Local PostgREST not configured');
    return;
  }
  for (const address of [ADMIN_URL, process.env.E2E_PGRST, process.env.E2E_DB_URL ?? ADMIN_URL]) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)) {
      throw new Error('Article editor E2E only accepts loopback targets');
    }
  }
  db = await freshDb('cmsarticle', { files: [SHIM, ...migrationFiles()] });
  if (!/^azsou_test_cmsarticle_[0-9]+$/.test(db.name)) throw new Error('Unexpected pilot database');
  await db.pool.query(readFileSync(join(ROOT, 'db/pilots/article-drafts.sql'), 'utf8'));
  const port = await freePort();
  child = await startPostgrest(db.name, port);
  origin = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  child?.kill();
  child = undefined;
  const current = db;
  db = undefined;
  await current?.close();
});

type SignIn = (page: Page, user: TestUser) => Promise<void>;
async function asUser(page: Page, signIn: SignIn, uid: string = U.ada) {
  await forwardRest(page, origin);
  await signIn(page, { id: uid, name: 'Local fixture', email: 'fixture@example.com', token: tok(uid) });
}

function controls(page: Page) {
  return {
    slug: page.getByLabel('文章标识'),
    open: page.getByRole('button', { name: '打开草稿', exact: true }),
    title: page.getByLabel('文章标题'),
    body: page.getByLabel('正文源文本'),
    save: page.getByRole('button', { name: '保存私有草稿' }),
    reload: page.getByRole('button', { name: '重新读取', exact: true }),
    status: page.locator('#draft-status'),
  };
}

async function rows(key: string) {
  const sql = `select a.draft_revision, a.published_revision, r.fields, r.body_source, r.saved_by
    from private.cms_article_items a join private.cms_article_revisions r
    on r.item_id = a.id and r.revision = a.draft_revision where a.slug = $1`;
  return (await db!.pool.query(sql, [key])).rows;
}

function writes(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/rpc/az_cms_save_article_draft')) seen.push(r.url());
  });
  return seen;
}

const newKey = () => `ci-editor-${randomUUID()}`;

async function seed(key: string, fields: Record<string, unknown>, body: string) {
  const sql = 'select * from public.az_cms_save_article_draft($1, 0, $2::jsonb, $3)';
  const args = [key, JSON.stringify(fields), body];
  const res = await run(db!.pool, { role: 'authenticated', uid: U.ada }, sql, args, { commit: true });
  expect(res.ok).toBe(true);
}

test('站长从官方清单新建私有草稿；保存才落库，刷新后读回，不发布', async ({ page, signIn }, info) => {
  await asUser(page, signIn);
  const key = newKey();
  const seen = writes(page);
  await page.goto('/admin/official/');
  await page.getByRole('link', { name: '写文章草稿' }).click();
  await expect(page.getByRole('heading', { name: '文章草稿编辑器' })).toBeVisible();
  const c = controls(page);
  await c.slug.fill(key);
  await c.open.click();
  await expect(c.status).toContainText('首次保存后才会建立');
  expect(await rows(key)).toEqual([]);
  expect(seen).toHaveLength(0);
  await expect(c.save).toBeDisabled();
  await expect(page.getByRole('button', { name: '发布', exact: true })).toHaveCount(0);
  await c.title.fill('隔离试点');
  const text = '<p>第一段</p>\n第二段';
  await c.body.fill(text);
  await c.save.click();
  await expect(c.status).toContainText('草稿已保存，第 1 版。未发布。');
  expect(seen).toHaveLength(1);
  const record = { draft_revision: 1, published_revision: null, fields: { title: '隔离试点' } };
  expect(await rows(key)).toEqual([{ ...record, body_source: text, saved_by: U.ada }]);
  await page.reload();
  await expect(c.status).toContainText('已读取第 1 版');
  await expect(c.title).toHaveValue('隔离试点');
  await expect(c.body).toHaveValue(text);
  await expect(c.save).toBeDisabled();
  expect(seen).toHaveLength(1);
  if (['chromium-desktop', 'webkit-iphone'].includes(info.project.name)) {
    await info.attach('article-draft-editor', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test('只改标题时保留未知元数据、目录和未改正文的原始换行', async ({ page, signIn }) => {
  const key = newKey();
  const fields = { title: '之前', toc: ['一'], extra: { labels: ['原值'] } };
  const text = '  <p>一</p>\r\n二\r\n';
  await seed(key, fields, text);
  await asUser(page, signIn);
  await page.goto(`${editor}#${key}`);
  const c = controls(page);
  await expect(c.status).toContainText('已读取第 1 版');
  await c.title.fill('新标题');
  await c.save.click();
  await expect(c.status).toContainText('草稿已保存，第 2 版');
  const [saved] = await rows(key);
  expect(saved.fields).toEqual({ ...fields, title: '新标题' });
  expect(saved.body_source).toBe(text);
  expect(saved.published_revision).toBeNull();
});

test('两页改同一版：旧页只报一次冲突并保留文字，确认后才能读回新稿', async ({ page, signIn }) => {
  const key = newKey();
  await seed(key, { title: '并行编辑' }, '共同底稿');
  await asUser(page, signIn);
  const other = await page.context().newPage();
  try {
    await asUser(other, signIn);
    const a = controls(page);
    const b = controls(other);
    await Promise.all([page.goto(`${editor}#${key}`), other.goto(`${editor}#${key}`)]);
    await expect(a.body).toHaveValue('共同底稿');
    await expect(b.body).toHaveValue('共同底稿');
    await a.body.fill('先保存的一版');
    await a.save.click();
    await expect(a.status).toContainText('草稿已保存，第 2 版');
    const seen = writes(other);
    await b.body.fill('我还要保留的文字');
    const conflict = other.waitForResponse((r) => r.url().endsWith('/rpc/az_cms_save_article_draft'));
    await b.save.click();
    expect((await conflict).status()).toBe(409);
    await expect(b.status).toContainText('版本冲突');
    await expect(b.body).toHaveValue('我还要保留的文字');
    await expect(b.save).toBeDisabled();
    await b.reload.click();
    await other.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(b.body).toHaveValue('我还要保留的文字');
    await b.reload.click();
    await other.getByRole('dialog').getByRole('button', { name: '放弃本页修改' }).click();
    await expect(b.status).toContainText('已读取第 2 版');
    await expect(b.body).toHaveValue('先保存的一版');
    expect(seen).toHaveLength(1);
    expect((await rows(key))[0]).toMatchObject({ draft_revision: 2, body_source: '先保存的一版' });
  } finally {
    await other.close();
  }
});

test('读取接口未安装不等于新稿，不能发写请求', async ({ page, makeUser, signIn }) => {
  // The standard E2E database has the normal migrations but deliberately no article-draft pilot.
  await signIn(page, await makeUser('编辑器测试', { role: 'admin' }));
  const key = newKey();
  const seen = writes(page);
  const statuses: number[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith(readSuffix)) statuses.push(r.status());
  });
  await page.goto(`${editor}#${key}`);
  const c = controls(page);
  await expect(c.status).toContainText('尚未启用文章草稿服务');
  await expect(c.body).toBeHidden();
  await expect(page.locator('#draft-save')).toBeDisabled();
  expect(statuses).toEqual([404]);
  expect(seen).toHaveLength(0);
});

test('回执缺失时不报保存成功、不自动重发，输入继续可复制', async ({ page, signIn }) => {
  await asUser(page, signIn);
  const key = newKey();
  const seen = writes(page);
  const headers = { 'access-control-allow-origin': '*' };
  await page.route(saveUrl, (route) => route.fulfill({ status: 200, headers, json: [] }));
  await page.goto(`${editor}#${key}`);
  const c = controls(page);
  await expect(c.status).toContainText('首次保存后才会建立');
  await c.title.fill('未确认');
  await c.body.fill('待核对文本');
  await c.save.click();
  await expect(c.status).toContainText('未能确认保存结果');
  await expect(c.body).toHaveValue('待核对文本');
  await expect(c.save).toBeDisabled();
  expect(seen).toHaveLength(1);
  expect(await rows(key)).toEqual([]);
});

test('未登录和版主均不能编辑，也不发草稿读写请求', async ({ page, signIn }) => {
  const calls: string[] = [];
  await forwardRest(page, origin);
  page.on('request', (r) => {
    if (/\/rpc\/az_cms_(read|save)_article_draft$/.test(r.url())) calls.push(r.url());
  });
  await page.goto(`${editor}#${newKey()}`);
  await expect(page.locator('[data-gate-signed-out]')).toBeVisible();
  await expect(page.locator('[data-article-draft-editor]')).toBeHidden();
  await asUser(page, signIn, U.mia);
  await page.reload();
  await expect(page.locator('[data-gate-forbidden]')).toBeVisible();
  await expect(page.locator('[data-article-draft-editor]')).toBeHidden();
  await page.goto('/admin/official/');
  await expect(page.locator('[data-admin-body]')).toBeVisible();
  await expect(page.getByRole('link', { name: '写文章草稿' })).toHaveCount(0);
  expect(calls).toEqual([]);
});
