import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { U } from '../db/fixtures';
import { ADMIN_URL, ROOT, SHIM, migrationFiles, run } from '../db/helpers';
import { ANON, BIN, freePort, startPostgrest, tok } from '../db/postgrest';
import { freshDb } from '../db/setup';
import { expect, forwardRest, test, type TestUser } from './community-fixtures';

const editor = '/admin/official/article-draft/';
// The read-back fixture only ever shows visitors this exact slug.
const canary = 'sb09-release-check-8ce16f5f';
const transitionSuffix = '/rpc/az_cms_transition_article_release';
let db: Awaited<ReturnType<typeof freshDb>> | undefined;
let child: ChildProcess | undefined;
let origin: string;

// Browser -> native workbench -> actual local PostgREST -> disposable release SQL, never a hosted project.
test.beforeAll(async () => {
  test.setTimeout(60_000);
  test.skip(!/-(desktop|iphone)$/.test(test.info().project.name), 'Only desktop and iPhone viewports');
  if (!BIN || !process.env.E2E_PGRST || !process.env.DATABASE_URL) {
    if (process.env.CI) throw new Error('Article release E2E needs the CI loopback database and PostgREST');
    test.skip(true, 'Local PostgREST not configured');
    return;
  }
  for (const address of [ADMIN_URL, process.env.E2E_PGRST, process.env.E2E_DB_URL ?? ADMIN_URL]) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)) {
      throw new Error('Article release E2E only accepts loopback targets');
    }
  }
  db = await freshDb('cmsarticle', { files: [SHIM, ...migrationFiles()] });
  if (!/^azsou_test_cmsarticle_[0-9]+$/.test(db.name)) throw new Error('Unexpected pilot database');
  for (const file of ['article-drafts.sql', 'article-release.sql', 'article-release-readback.sql']) {
    await db.pool.query(readFileSync(join(ROOT, 'db/pilots', file), 'utf8'));
  }
  // Tests must still run without the SB10 reader on the test-first baseline.
  const publicReadPilot = join(ROOT, 'db/pilots/article-public-read.sql');
  if (existsSync(publicReadPilot)) await db.pool.query(readFileSync(publicReadPilot, 'utf8'));
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

function panel(page: Page) {
  const root = page.locator('[data-article-release]');
  return {
    summary: root.locator('[data-release-summary]'),
    note: root.locator('[data-release-status]'),
    review: root.getByRole('button', { name: '送审当前版本' }),
    publish: root.getByRole('button', { name: '发布已审版本' }),
    withdraw: root.getByRole('button', { name: '下架', exact: true }),
    restore: root.getByRole('button', { name: '恢复为待审' }),
  };
}

type Act = 'review' | 'publish' | 'withdraw' | 'restore';
const acts: Act[] = ['review', 'publish', 'withdraw', 'restore'];

async function onlyEnabled(p: ReturnType<typeof panel>, enabled: Act[]) {
  for (const act of acts) {
    if (enabled.includes(act)) await expect(p[act]).toBeEnabled();
    else await expect(p[act]).toBeDisabled();
  }
}

function transitions(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(transitionSuffix)) seen.push(r.url());
  });
  return seen;
}

const newKey = () => `ci-release-${randomUUID()}`;

// Exactly the 14 pilot fields the release SQL accepts. Synthetic data only.
function releaseFields(title: string) {
  return {
    title,
    category: '合成分类',
    badge: '示例',
    author: '测试编辑部',
    date: '2025-01-01',
    lastChecked: '2025-01-02',
    readingMinutes: 2,
    toc: ['合成章节'],
    tags: ['one', 'two'],
    forumThread: 'example-seed',
    ogImage: '/og/fixture.png',
    art: null,
    pinyin: 'hc',
    order: 3,
  };
}

async function seed(key: string, fields: Record<string, unknown>, body: string) {
  const sql = 'select * from public.az_cms_save_article_draft($1, 0, $2::jsonb, $3)';
  const args = [key, JSON.stringify(fields), body];
  const res = await run(db!.pool, { role: 'authenticated', uid: U.ada }, sql, args, { commit: true });
  expect(res.ok).toBe(true);
}

async function transition(key: string, action: string, draft: number, release: number) {
  const sql = 'select * from public.az_cms_transition_article_release($1, $2, $3, $4, $5::uuid)';
  const args = [key, action, draft, release, randomUUID()];
  const res = await run(db!.pool, { role: 'authenticated', uid: U.ada }, sql, args, { commit: true });
  expect(res.ok).toBe(true);
}

async function events(key: string) {
  const sql = `select e.action, e.phase, e.release_version, e.published_revision, e.actor_id
    from private.cms_article_release_events e join private.cms_article_items a on a.id = e.item_id
    where a.slug = $1 order by e.release_version`;
  return (await db!.pool.query(sql, [key])).rows;
}

const step = (action: string, phase: string, version: number, live: number | null) => ({
  action,
  phase,
  release_version: version,
  published_revision: live,
  actor_id: U.ada,
});

async function rpc(name: string, args: Record<string, unknown>, token: string) {
  const res = await fetch(`${origin}/rpc/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

// Visitors have no sign-in: only the anon key, never the station session.
async function visitorRead(slug: string) {
  const res = await rpc('az_cms_read_published_article_canary', { p_slug: slug }, ANON);
  expect(res.status).toBe(200);
  return res.json;
}

const idle = '未送审 · 草稿第 1 版 · 访客不可见';
const waiting = '待审 · 第 1 版待发布 · 访客不可见';

test('站长在发布面板送审、发布、下架、恢复，访客读取随之出现和消失', async ({ page, signIn }) => {
  const body = '发布验收正文\n第二行';
  await seed(canary, releaseFields('发布验收'), body);
  const seen = transitions(page);
  await asUser(page, signIn);
  await page.goto(`${editor}#${canary}`);
  const p = panel(page);
  await expect(page.locator('#draft-status')).toContainText('已读取第 1 版');
  await expect(p.summary).toHaveText(idle);
  await onlyEnabled(p, ['review']);
  expect(await visitorRead(canary)).toEqual([]);

  await p.review.click();
  await expect(p.note).toHaveText('已送审当前版本。还没有发布。');
  await expect(p.summary).toHaveText(waiting);
  await onlyEnabled(p, ['publish']);
  expect(await visitorRead(canary)).toEqual([]);

  // Cancelling the confirmation writes nothing.
  await p.publish.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('发布这一版？');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  expect(seen).toHaveLength(1);
  expect(await events(canary)).toHaveLength(1);

  await p.publish.click();
  await dialog.getByRole('button', { name: '发布', exact: true }).click();
  await expect(p.note).toHaveText('已发布。访客现在可以看到这一版。');
  await expect(p.summary).toHaveText('已发布第 1 版');
  await onlyEnabled(p, ['withdraw']);
  const visible = [{ slug: canary, revision: 1, title: '发布验收', body_text: body }];
  expect(await visitorRead(canary)).toEqual(visible);

  await p.withdraw.click();
  await expect(dialog).toContainText('下架这篇文章？');
  await dialog.getByRole('button', { name: '下架', exact: true }).click();
  await expect(p.note).toHaveText('已下架。访客不可见；草稿和历史都保留。');
  await expect(p.summary).toHaveText('已下架 · 草稿第 1 版 · 访客不可见');
  await onlyEnabled(p, ['restore']);
  expect(await visitorRead(canary)).toEqual([]);

  await p.restore.click();
  await expect(p.note).toHaveText('已恢复为待审。访客仍不可见，需要重新发布。');
  await expect(p.summary).toHaveText(waiting);
  await onlyEnabled(p, ['publish']);
  expect(await visitorRead(canary)).toEqual([]);

  await page.reload();
  await expect(p.summary).toHaveText(waiting);
  expect(seen).toHaveLength(4);
  expect(await events(canary)).toEqual([
    step('submit_review', 'review', 1, null),
    step('publish', 'published', 2, 1),
    step('withdraw', 'withdrawn', 3, null),
    step('restore_review', 'review', 4, null),
  ]);
});

test('另一页已送审后，旧页再送审只被拒绝一次，并读回新状态', async ({ page, signIn }) => {
  const key = newKey();
  await seed(key, releaseFields('并行送审'), '共同底稿');
  await asUser(page, signIn);
  const other = await page.context().newPage();
  try {
    await asUser(other, signIn);
    const a = panel(page);
    const b = panel(other);
    await Promise.all([page.goto(`${editor}#${key}`), other.goto(`${editor}#${key}`)]);
    await expect(a.summary).toHaveText(idle);
    await expect(b.summary).toHaveText(idle);
    await a.review.click();
    await expect(a.note).toHaveText('已送审当前版本。还没有发布。');
    const seen = transitions(other);
    const rejected = other.waitForResponse((r) => r.url().endsWith(transitionSuffix));
    await b.review.click();
    expect((await rejected).status()).toBe(409);
    await expect(b.note).toContainText('已重新读取');
    await expect(b.summary).toHaveText(waiting);
    await onlyEnabled(b, ['publish']);
    expect(seen).toHaveLength(1);
    expect(await events(key)).toHaveLength(1);
  } finally {
    await other.close();
  }
});

test('非站长和访客不能调用发布接口；非验收文章即使已发布，访客也读不到', async () => {
  const key = newKey();
  await seed(key, releaseFields('权限检查'), '正文');
  const move = {
    p_slug: key,
    p_action: 'submit_review',
    p_expected_draft: 1,
    p_expected_release: 0,
    p_operation_id: randomUUID(),
  };
  const mod = await rpc('az_cms_transition_article_release', move, tok(U.mia));
  expect(mod.status).toBe(403);
  const anon = await rpc('az_cms_transition_article_release', move, ANON);
  expect([401, 403]).toContain(anon.status);
  const read = { p_slug: key };
  expect((await rpc('az_cms_read_article_release_state', read, tok(U.mia))).status).toBe(403);
  expect([401, 403]).toContain((await rpc('az_cms_read_article_release_state', read, ANON)).status);
  expect(await events(key)).toEqual([]);

  await transition(key, 'submit_review', 1, 0);
  await transition(key, 'publish', 1, 1);
  expect(await events(key)).toHaveLength(2);
  expect(await visitorRead(key)).toEqual([]);
});

// SB10: one non-canary URL, a real local published reader, and no signed-in browser session.
test('SB10：同一文章地址随发布、下架和恢复显示正确版本', async ({ page, baseURL }) => {
  if (!baseURL || new URL(baseURL).hostname !== '127.0.0.1') throw new Error('Local article site required');
  const slug = `sb10-e2e-${randomUUID()}`;
  const url = new URL('/articles/published/', baseURL);
  url.searchParams.set('slug', slug);
  const target = url.href;
  const reader = '/rest/v1/rpc/az_cms_read_published_article';
  const wrongReaders = new Set([
    '/rest/v1/rpc/az_cms_read_article_draft',
    '/rest/v1/rpc/az_cms_read_article_release_state',
    '/rest/v1/rpc/az_cms_read_published_article_canary',
  ]);
  const fallbackRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (wrongReaders.has(path)) fallbackRequests.push(path);
  });
  const main = page.getByRole('main');
  const status = main.locator('[data-article-public-status]');
  const edition = (revision: number) => ({
    slug,
    revision,
    title: `SB10 合成标题 ${revision}`,
    body_text: `SB10 合成正文 ${revision}：字面量 <em>标记</em>。`,
  });
  const v1 = edition(1);
  const v2 = edition(2);
  await forwardRest(page, origin);

  // Fail at the missing local page on the baseline, not after a timeout waiting for its RPC.
  const shell = await page.request.get(target, { maxRedirects: 0 });
  try {
    expect(shell.status(), 'SB10: the public article page must exist').toBe(200);
  } finally {
    await shell.dispose();
  }

  async function openArticle() {
    const [reply, navigation] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(reader) && r.request().method() === 'POST'),
      page.goto(target, { waitUntil: 'domcontentloaded' }),
    ]);
    expect(navigation?.status()).toBe(200);
    await expect(page).toHaveURL(target);
    expect(reply.request().postDataJSON()).toEqual({ p_slug: slug });
    expect(Object.keys(await reply.request().allHeaders())).not.toContain('authorization');
    return reply;
  }

  async function noTrace(item: typeof v1) {
    await expect(main).not.toContainText(item.title);
    await expect(main).not.toContainText(`SB10 合成正文 ${item.revision}`);
  }

  async function check(live: typeof v1 | null) {
    const reply = await openArticle();
    expect(reply.status()).toBe(200);
    expect(await reply.json()).toEqual(live ? [live] : []);
    if (live) {
      await expect(main.getByRole('heading', { level: 1, name: live.title, exact: true })).toBeVisible();
      await expect(main.getByText(live.body_text, { exact: true })).toBeVisible();
    } else {
      await expect(status).toBeVisible();
      await expect(status).toContainText('尚未发布');
    }
    for (const item of [v1, v2]) {
      if (item !== live) await noTrace(item);
    }
  }

  await check(null);
  await seed(slug, releaseFields(v1.title), v1.body_text);
  await check(null);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
  await transition(slug, 'submit_review', 1, 0);
  await check(null);
  await transition(slug, 'publish', 1, 1);
  await check(v1);
  expect(await visitorRead(slug)).toEqual([]);

  const saved = await run(
    db!.pool,
    { role: 'authenticated', uid: U.ada },
    'select * from public.az_cms_save_article_draft($1, 1, $2::jsonb, $3)',
    [slug, JSON.stringify(releaseFields(v2.title)), v2.body_text],
    { commit: true },
  );
  expect(saved).toMatchObject({ ok: true, rows: [{ revision: 2 }] });
  await check(v1);
  await transition(slug, 'submit_review', 2, 2);
  await check(v1);
  await transition(slug, 'withdraw', 2, 3);
  await check(null);
  await transition(slug, 'restore_review', 2, 4);
  await check(null);
  await transition(slug, 'publish', 2, 5);
  await check(v2);

  // Only this last read is simulated: an outage must not redisplay content or look like an unpublished row.
  await page.route(`**${reader}`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{}',
    });
  });
  expect((await openArticle()).status()).toBe(503);
  await expect(status).toBeVisible();
  await expect(status).toContainText('读取失败');
  await noTrace(v1);
  await noTrace(v2);
  expect(fallbackRequests).toEqual([]);
});
