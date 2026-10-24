import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, forwardRest, seedReply, seedThread, uniq } from './community-fixtures';

/**
 * P3 社区流程（真实 Postgres + PostgREST + RLS + 触发器）：
 * 发帖、回帖、编辑（已编辑标记）、删除、Markdown 预览与净化、草稿、点赞、收藏、举报、通知与未读角标、
 * 版主置顶/锁定/精华/隐藏、种子主题回帖、文章评论、限流提示、论坛搜索、个人主页、分页、无障碍。
 */

const threadUrl = (id: string) => `/forum/t/?id=${id}`;

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.map(
    (v) =>
      `${v.id}: ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
}

test.describe('发帖', () => {
  test('未登录访问发帖页：显示登录引导', async ({ page, db: _db }) => {
    void _db;
    await page.goto('/forum/new/?cat=tech');
    await expect(page.getByRole('heading', { name: '登录后发帖' })).toBeVisible();
    await expect(page.getByRole('link', { name: '登录', exact: true })).toHaveAttribute(
      'href',
      '/login/?next=%2Fforum%2Fnew%2F%3Fcat%3Dtech',
    );
  });

  test('选择分类、写 Markdown（实时预览）、发布后跳到主题页；XSS 被净化', async ({
    page,
    makeUser,
    signIn,
    errors,
  }) => {
    const u = await makeUser(uniq('作者'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    const form = page.locator('form[data-signed-in]');
    await expect(form).toBeVisible();
    await expect(page.getByRole('radio', { name: '技术交流' })).toBeChecked();
    // 公告只有管理员可见
    await expect(page.getByRole('radio', { name: '公告' })).toBeHidden();
    const title = uniq('E2E 新主题 ');
    await page.getByLabel('标题').fill(title);
    const body = page.locator('#nt-body');
    await body.fill(
      '**加粗文字** 与 `code`\n\n<img src=x onerror="window.__xss=1">\n\n[坏链接](javascript:window.__xss=1)',
    );
    // 预览：窄屏切到「预览」，宽屏并排
    const previewBtn = page.getByRole('button', { name: '预览', exact: true });
    if (await previewBtn.isVisible()) await previewBtn.click();
    const preview = page.getByRole('region', { name: '预览' });
    await expect(preview.locator('strong')).toHaveText('加粗文字');
    await expect(preview.locator('img')).toHaveCount(0);
    await page.getByRole('button', { name: '发布主题' }).click();
    await expect(page).toHaveURL(/\/forum\/t\/\?id=[0-9a-f-]{36}$/);
    await expect(page.locator('h1')).toHaveText(title);
    await expect(page.locator('[data-body] strong')).toHaveText('加粗文字');
    await expect(page.locator('[data-body] img')).toHaveCount(0);
    await expect(page.locator('[data-body] a[href^="javascript"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    // SEO：标题、canonical、JSON-LD
    await expect(page).toHaveTitle(`${title} · 论坛 · AZ Studio`);
    const id = new URL(page.url()).searchParams.get('id')!;
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://azsou.com/forum/t/?id=${id}`,
    );
    const ld = await page.locator(`script[data-thread="${id}"]`).textContent();
    expect(JSON.parse(ld!)['@type']).toBe('DiscussionForumPosting');
    // 出现在分类页的社区主题里
    await page.goto('/forum/tech/');
    await expect(page.locator('[data-db-list]').getByRole('link', { name: new RegExp(title) })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('草稿自动保存：刷新后恢复，可丢弃', async ({ page, makeUser, signIn }) => {
    const u = await makeUser(uniq('草稿'));
    await signIn(page, u);
    await page.goto('/forum/new/');
    await page.getByLabel('标题').fill('草稿标题');
    await page.locator('#nt-body').fill('写到一半的正文');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByLabel('标题')).toHaveValue('草稿标题');
    await expect(page.locator('#nt-body')).toHaveValue('写到一半的正文');
    await expect(page.getByText('已恢复上次未发送的草稿。')).toBeVisible();
    await page.getByRole('button', { name: '丢弃草稿' }).click();
    await expect(page.locator('#nt-body')).toHaveValue('');
  });

  test('工具栏：选中文字点「粗体」包上 **；超出长度时字数变红并阻止提交', async ({
    page,
    makeUser,
    signIn,
  }) => {
    const u = await makeUser(uniq('工具栏'));
    await signIn(page, u);
    await page.goto('/forum/new/');
    const ta = page.locator('#nt-body');
    await ta.fill('你好');
    await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 2));
    await page.getByRole('button', { name: /^粗体/ }).click();
    await expect(ta).toHaveValue('**你好**');
    await ta.fill('长'.repeat(4001));
    await expect(page.locator('.composer__count')).toHaveText('4001 / 4000');
    await expect(page.locator('.composer__count')).toHaveClass(/is-over/);
    await page.getByLabel('标题').fill('长度测试');
    await page.getByRole('button', { name: '发布主题' }).click();
    await expect(page.locator('[data-error-for="body"]')).toHaveText('正文最多 4000 个字符');
    await expect(page).toHaveURL(/\/forum\/new\//);
  });

  test('限流（PT429）显示中文提示', async ({ page, db, makeUser, signIn }) => {
    const u = await makeUser(uniq('刷屏'));
    await db.query(
      `insert into public.rate_limit_events (user_id, action) select $1, 'thread' from generate_series(1, 3)`,
      [u.id],
    );
    await signIn(page, u);
    await page.goto('/forum/new/');
    await page.getByLabel('标题').fill('第四个主题');
    await page.locator('#nt-body').fill('正文');
    await page.getByRole('button', { name: '发布主题' }).click();
    await expect(page.locator('[data-form-status]')).toHaveText(
      '发主题太频繁了：为防止刷屏，每 10 分钟最多发主题 3 次。请稍后再试。',
    );
  });

  test('被封禁用户看到限制提示', async ({ page, makeUser, signIn }) => {
    const u = await makeUser(uniq('封禁'), { banned: true });
    await signIn(page, u);
    await page.goto('/forum/new/');
    await expect(page.getByText('你的账号已被限制发言，暂时不能发主题。')).toBeVisible();
    await expect(page.locator('form[data-signed-in]')).toBeHidden();
  });
});

test.describe('主题页', () => {
  test('回复、编辑（显示已编辑）、删除；楼主收到通知与未读角标', async ({
    page,
    browser,
    db,
    makeUser,
    signIn,
  }) => {
    const op = await makeUser(uniq('楼主'));
    const u = await makeUser(uniq('回复者'));
    const id = await seedThread(db, op.id, { title: uniq('讨论 ') });
    await signIn(page, u);
    await page.goto(threadUrl(id));
    await expect(page.locator('h1')).not.toHaveText('正在加载主题…');
    const text = uniq('我的回复 ');
    await page.getByLabel('写回复').fill(`${text}\n\n- 列表项`);
    await page.getByRole('button', { name: '发布回复' }).click();
    const item = page.locator('[data-list] li.post', { hasText: text });
    await expect(item).toBeVisible();
    await expect(item.locator('li')).toHaveText('列表项');
    await expect(page.locator('[data-count]')).toHaveText('1 条回复');
    // 编辑
    await item.getByRole('button', { name: '编辑' }).click();
    await item.getByLabel('编辑回复').fill(`${text}（已修改）`);
    await item.getByRole('button', { name: '保存' }).click();
    await expect(item.locator('.comment__body')).toHaveText(`${text}（已修改）`);
    await expect(item.locator('.comment__edited')).toContainText('已编辑');
    // 刷新后编辑标记仍在（来自数据库 edited_at）
    await page.reload();
    const again = page.locator('[data-list] li.post', { hasText: text });
    await expect(again.locator('.comment__edited')).toContainText('已编辑');

    // 楼主：未读角标与通知页
    const ctx = await browser.newContext({
      baseURL: 'http://127.0.0.1:4321',
      serviceWorkers: 'block',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const p2 = await ctx.newPage();
    await forwardRest(p2);
    await signIn(p2, op);
    await p2.goto('/forum/');
    await expect(p2.locator('[data-unread-badge]')).toHaveText('1');
    await p2.goto('/notifications/');
    const n = p2.locator('[data-list] li', { hasText: '回复了你的主题' });
    await expect(n).toContainText(u.name);
    await expect(n).toHaveClass(/is-unread/);
    await n.getByRole('link').click();
    await expect(p2).toHaveURL(new RegExp(`/forum/t/\\?id=${id}#r-`));
    await expect(p2.locator('li.post.is-target')).toBeVisible();
    await p2.goto('/notifications/');
    await expect(p2.locator('[data-list] li.is-unread')).toHaveCount(0);
    await expect(p2.locator('[data-unread-badge]')).toBeHidden();
    await ctx.close();

    // 删除
    await again.getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page.locator('[data-list] li.post', { hasText: text })).toHaveCount(0);
    const left = await db.query(`select count(*)::int as n from forum_replies where thread = $1`, [id]);
    expect(left.rows[0].n).toBe(0);
  });

  test('楼主编辑主题与删除主题', async ({ page, db, makeUser, signIn }) => {
    const op = await makeUser(uniq('楼主'));
    const id = await seedThread(db, op.id, { title: '原标题', body: '原正文' });
    await signIn(page, op);
    await page.goto(threadUrl(id));
    await page.locator('[data-thread-actions]').getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('标题').fill('新标题');
    await page.locator('#edit-body').fill('新的 **正文**');
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('h1')).toHaveText('新标题');
    await expect(page.locator('[data-body] strong')).toHaveText('正文');
    await expect(page.locator('[data-meta]')).toContainText('已编辑');
    await page.locator('[data-thread-actions]').getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除主题' }).click();
    await expect(page).toHaveURL(/\/forum\/tech\/$/);
    const r = await db.query(`select count(*)::int as n from forum_threads where id = $1`, [id]);
    expect(r.rows[0].n).toBe(0);
  });

  test('点赞、收藏（/bookmarks/ 列表）、举报（写入 reports）', async ({ page, db, makeUser, signIn }) => {
    const op = await makeUser(uniq('楼主'));
    const u = await makeUser(uniq('读者'));
    const title = uniq('值得收藏 ');
    const id = await seedThread(db, op.id, { title });
    const rid = await seedReply(db, op.id, id, '一条可以举报的回复');
    await signIn(page, u);
    await page.goto(threadUrl(id));
    const bar = page.locator('[data-thread-actions]');
    const like = bar.locator('[data-act="like"]');
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(like).toHaveText(/赞 1$/);
    await bar.getByRole('button', { name: /收藏/ }).click();
    await expect(bar.locator('[data-act="bookmark"]')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('[data-thread-actions] [data-act="like"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('[data-thread-actions] [data-act="bookmark"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 举报回复
    await page.locator(`#r-${rid}`).getByRole('button', { name: '举报' }).click();
    const dlg = page.getByRole('dialog', { name: '举报这条内容' });
    await dlg.getByLabel('泄露他人隐私').check();
    await dlg.getByLabel('补充说明').fill('包含手机号');
    await dlg.getByRole('button', { name: '提交举报' }).click();
    await expect(page.locator('.toast')).toContainText('已收到举报');
    const rep = await db.query(
      `select reason, detail, status, target_type from reports where target_id = $1`,
      [rid],
    );
    expect(rep.rows).toEqual([
      { reason: 'privacy', detail: '包含手机号', status: 'open', target_type: 'reply' },
    ]);
    // 重复举报：友好提示
    await page.locator(`#r-${rid}`).getByRole('button', { name: '举报' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '提交举报' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已经举报过');
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    // 收藏夹
    await page.goto('/bookmarks/');
    const row = page.locator('[data-list] li', { hasText: title });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /取消收藏/ }).click();
    await expect(page.locator('[data-list]')).toContainText('还没有收藏');
  });

  test('版主：置顶 / 精华 / 锁定 / 隐藏；锁定后普通用户不能回复', async ({
    page,
    browser,
    db,
    makeUser,
    signIn,
  }) => {
    const mod = await makeUser(uniq('版主'), { role: 'moderator' });
    const op = await makeUser(uniq('楼主'));
    const id = await seedThread(db, op.id, { title: uniq('待管理 ') });
    await signIn(page, mod);
    await page.goto(threadUrl(id));
    const tools = page.getByRole('group', { name: '版主工具' });
    await tools.getByRole('button', { name: '置顶' }).click();
    await expect(tools.getByRole('button', { name: '取消置顶' })).toBeVisible();
    await tools.getByRole('button', { name: '设为精华' }).click();
    await tools.getByRole('button', { name: '锁定' }).click();
    await expect(page.locator('[data-cat]')).toContainText('置顶');
    await expect(page.locator('[data-cat]')).toContainText('精华');
    await expect(page.locator('[data-cat]')).toContainText('已锁定');
    const row = await db.query(`select pinned, featured, locked from forum_threads where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ pinned: true, featured: true, locked: true });
    // 普通用户：看到锁定提示，没有回复框
    const ctx = await browser.newContext({
      baseURL: 'http://127.0.0.1:4321',
      serviceWorkers: 'block',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const p2 = await ctx.newPage();
    await forwardRest(p2);
    const u = await makeUser(uniq('路人'));
    await signIn(p2, u);
    await p2.goto(threadUrl(id));
    await expect(p2.getByText('这个主题已锁定，不能再回复。')).toBeVisible();
    await expect(p2.getByLabel('写回复')).toHaveCount(0);
    // 隐藏后普通用户看不到
    await tools.getByRole('button', { name: '隐藏' }).click();
    await expect(page.locator('[data-cat]')).toContainText('已隐藏');
    await p2.reload();
    await expect(p2.locator('h1')).toHaveText('主题不存在或已被删除');
    await expect(p2.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');
    await ctx.close();
    // 置顶主题出现在分类页最前（隐藏前先恢复）
    await tools.getByRole('button', { name: '恢复显示' }).click();
    await page.goto('/forum/tech/');
    await expect(page.locator('[data-db-list] li').first()).toContainText('置顶');
  });

  test('种子主题：数据库回复挂在 seed_key 上；未登录看到登录引导', async ({ page, db, makeUser, signIn }) => {
    await page.goto('/forum/t/t-svg-assets/');
    await expect(page.getByText('登录后即可回复。')).toBeVisible();
    const u = await makeUser(uniq('种子回复'));
    await signIn(page, u);
    await page.goto('/forum/t/t-svg-assets/');
    const text = uniq('种子主题下的回复 ');
    await page.getByLabel('写回复').fill(text);
    await page.getByRole('button', { name: '发布回复' }).click();
    await expect(page.locator('[data-list] li.post', { hasText: text })).toBeVisible();
    const r = await db.query(`select seed_key, thread from forum_replies where body = $1`, [text]);
    expect(r.rows).toEqual([{ seed_key: 't-svg-assets', thread: null }]);
  });

  test('无障碍：主题页（含回复框与举报框）axe 无违规', async ({ page, db, makeUser, signIn }) => {
    const op = await makeUser(uniq('楼主'));
    const u = await makeUser(uniq('读者'));
    const id = await seedThread(db, op.id, { body: '# 标题\n\n> 引用\n\n```\ncode\n```' });
    await seedReply(db, op.id, id, '**回复**');
    await signIn(page, u);
    await page.goto(threadUrl(id));
    await expect(page.getByLabel('写回复')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.locator('[data-thread-actions]').getByRole('button', { name: '举报' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('评论', () => {
  test('文章页：发表、编辑、删除评论；版主可隐藏', async ({ page, browser, db, makeUser, signIn }) => {
    const u = await makeUser(uniq('评论者'));
    await signIn(page, u);
    await page.goto('/articles/pinyin-initial-search/');
    const text = uniq('好文章 ');
    const box = page.locator('[data-comments]');
    await box.getByLabel('写评论').fill(`${text} *赞*`);
    await box.getByRole('button', { name: '发表评论' }).click();
    const item = box.locator('li.post', { hasText: text });
    await expect(item.locator('em')).toHaveText('赞');
    await item.getByRole('button', { name: '编辑' }).click();
    await item.getByLabel('编辑评论').fill(`${text} 改过`);
    await item.getByRole('button', { name: '保存' }).click();
    await expect(item.locator('.comment__edited')).toContainText('已编辑');
    const cid = await item.getAttribute('data-id');
    // 版主隐藏
    const mod = await makeUser(uniq('版主'), { role: 'moderator' });
    const ctx = await browser.newContext({
      baseURL: 'http://127.0.0.1:4321',
      serviceWorkers: 'block',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const p2 = await ctx.newPage();
    await forwardRest(p2);
    await signIn(p2, mod);
    await p2.goto('/articles/pinyin-initial-search/');
    await p2.locator(`#c-${cid}`).getByRole('button', { name: '隐藏' }).click();
    await expect(p2.locator(`#c-${cid}`)).toHaveClass(/is-hidden/);
    const r = await db.query(`select published from comments where id = $1`, [cid]);
    expect(r.rows[0].published).toBe(false);
    await ctx.close();
    // 作者仍能看到（标注已隐藏）并删除
    await page.reload();
    const mine = page.locator(`#c-${cid}`);
    await expect(mine).toContainText('已隐藏');
    await mine.getByRole('button', { name: '删除' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
    await expect(page.locator(`#c-${cid}`)).toHaveCount(0);
  });
});

test.describe('搜索、个人主页、分页', () => {
  test('/search/ 同时搜到站内内容与数据库主题（中文）', async ({ page, db, makeUser }) => {
    const op = await makeUser(uniq('搜索'));
    const token = `蓝鲸${uniq()}`;
    await seedThread(db, op.id, { title: `关于${token}的讨论`, body: '正文里也有内容' });
    await page.goto(`/search/?q=${encodeURIComponent(token)}`);
    const sec = page.locator('[data-forum-results]');
    await expect(sec.getByRole('link', { name: new RegExp(token) })).toBeVisible();
    await page.goto(`/search/?q=${encodeURIComponent('拼音')}`);
    await expect(page.locator('[data-results] a').first()).toBeVisible();
  });

  test('/u/?id= 显示昵称、加入时间与主题（分页加载更多）', async ({ page, db, makeUser }) => {
    const name = uniq('主页用户');
    const u = await makeUser(name);
    for (let i = 0; i < 23; i++)
      await seedThread(db, u.id, {
        title: `第 ${i} 帖`,
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
      });
    await page.goto(`/u/?id=${u.id}`);
    await expect(page.locator('h1')).toHaveText(name);
    await expect(page.locator('[data-joined]')).toContainText('加入');
    await expect(page).toHaveTitle(`${name} · 用户主页 · AZ Studio`);
    const rows = page.locator('[data-list] li');
    await expect(rows).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(rows).toHaveCount(23);
    await expect(page.getByRole('button', { name: '加载更多' })).toBeHidden();
    await expect(rows.first()).toHaveText(/第 0 帖/);
    await expect(rows.last()).toHaveText(/第 22 帖/);
  });

  test('论坛分类页：社区主题游标分页，无重复', async ({ page, db: _db }) => {
    void _db;
    await page.goto('/forum/meta/');
    const list = page.locator('[data-db-list] li[data-thread-id]');
    await expect(list).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect.poll(() => list.count()).toBeGreaterThan(20);
    const ids = await list.evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')));
    expect(new Set(ids).size).toBe(ids.length);
    await expect(page.locator('[data-db-list]')).toContainText('分页夹具主题 30');
  });

  test('无障碍：已登录的发帖页、通知页、收藏页 axe 无违规', async ({ page, makeUser, signIn }) => {
    const u = await makeUser(uniq('无障碍'));
    await signIn(page, u);
    for (const path of ['/forum/new/', '/notifications/', '/bookmarks/', `/u/?id=${u.id}`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await axe(page), path).toEqual([]);
    }
  });
});
