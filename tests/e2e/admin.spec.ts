import { readdirSync, readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { emulateColorScheme } from './fixtures';
import { BASE_URL } from './port';
import {
  test,
  expect,
  forwardRest,
  seedReply,
  seedThread,
  uniq,
  useRealSettings,
} from './community-fixtures';

/**
 * P4 管理后台（真实 Postgres + PostgREST + RLS + 0009 RPC）：
 * 权限门、仪表盘、举报队列（单条 / 批量 / 封禁）、内容管理、用户（角色 / 封禁）、审计日志与 CSV、
 * 站点设置（公告条、注册开关）、导入导出、官方内容、@提及通知、暗色模式与无障碍。
 */

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

const body = (page: Page) => page.locator('[data-admin-body]');
const dialog = (page: Page) => page.locator('dialog[open]');

async function report(
  db: import('pg').Pool,
  reporter: string,
  type: string,
  target: string,
  reason = 'spam',
) {
  const r = await db.query(
    `insert into public.reports (reporter, target_type, target_id, reason, detail) values ($1, $2, $3, $4, 'E2E 举报说明') returning id`,
    [reporter, type, target, reason],
  );
  return r.rows[0].id as string;
}

test.describe('权限门', () => {
  test('未登录 → 登录引导；普通用户 → 无权限；被封禁的版主 → 受限', async ({ page, makeUser, signIn }) => {
    await page.goto('/admin/');
    await expect(page.getByText('管理后台需要登录。')).toBeVisible();
    await expect(page.locator('[data-gate-login]')).toHaveAttribute('href', '/login/?next=%2Fadmin%2F');
    await expect(body(page)).toBeHidden();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');

    const u = await makeUser(uniq('普通'));
    await signIn(page, u);
    await page.goto('/admin/reports/');
    await expect(page.getByText('你的账号没有访问管理后台的权限。')).toBeVisible();
    await expect(body(page)).toBeHidden();
  });

  test('版主：看不到管理员菜单；打开管理员页面提示「仅管理员可用」', async ({ page, makeUser, signIn }) => {
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    await signIn(page, m);
    await page.goto('/admin/');
    await expect(body(page)).toBeVisible();
    const nav = page.getByRole('navigation', { name: '后台导航' });
    await expect(nav.getByRole('link', { name: '举报队列' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '审计日志' })).toBeHidden();
    await expect(nav.getByRole('link', { name: '站点设置' })).toBeHidden();
    await page.goto('/admin/settings/');
    await expect(page.getByText('这个页面仅管理员可用。')).toBeVisible();
    await expect(body(page)).toBeHidden();
  });
});

test.describe('仪表盘', () => {
  test('计数卡片、30 天图表（含数据表）、无障碍', async ({ page, makeUser, signIn, errors }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await signIn(page, a);
    await page.goto('/admin/');
    const stats = page.locator('[data-stats]');
    await expect(stats).not.toHaveAttribute('aria-busy');
    for (const label of ['用户', '主题', '回复', '评论', '待处理举报', '近 7 天注册'])
      await expect(stats.getByText(label, { exact: true })).toBeVisible();
    const users = Number(
      (await stats.locator('.stat').first().locator('.stat__value').textContent())!.replace(/,/g, ''),
    );
    expect(users).toBeGreaterThan(0);
    await expect(page.locator('[data-chart] svg[role="img"]')).toHaveAttribute('aria-label', /近 30 天/);
    await page.getByText('查看数据表').click();
    await expect(page.locator('[data-chart-table] tbody tr')).toHaveCount(30);
    // 管理员能看到全部菜单
    await expect(
      page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '审计日志' }),
    ).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('举报队列', () => {
  test('隐藏被举报主题（写处理说明）→ 离开队列、主题隐藏、举报人收到通知、审计记录', async ({
    page,
    db,
    makeUser,
    signIn,
    errors,
  }) => {
    const author = await makeUser(uniq('被举报'));
    const reporter = await makeUser(uniq('举报人'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const title = uniq('违规主题 ');
    const tid = await seedThread(db, author.id, { title });
    const rid = await report(db, reporter.id, 'thread', tid);
    await signIn(page, m);
    await page.goto('/admin/reports/?type=thread');
    const card = page.locator(`[data-id="${rid}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText(title)).toBeVisible();
    await expect(card.getByRole('link', { name: author.name })).toHaveAttribute(
      'href',
      `/admin/users/view/?id=${author.id}`,
    );
    await expect(card.getByRole('link', { name: '打开原文' })).toHaveAttribute('href', `/forum/t/?id=${tid}`);
    await card.getByRole('button', { name: '隐藏内容' }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByLabel('处理说明（选填，写入审计日志）').fill('广告引流');
    await dialog(page).getByRole('button', { name: '确定' }).click();
    await expect(page.getByText('举报已处理。')).toBeVisible();
    await expect(card).toHaveCount(0);
    const t = await db.query(`select published from forum_threads where id = $1`, [tid]);
    expect(t.rows[0].published).toBe(false);
    const r = await db.query(`select status, resolution_note, resolved_by from reports where id = $1`, [rid]);
    expect(r.rows[0]).toEqual({ status: 'resolved', resolution_note: '广告引流', resolved_by: m.id });
    const audit = await db.query(`select action from audit_log where target_id = $1 order by id`, [tid]);
    expect(audit.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining(['report.action.hide', 'thread.update']),
    );
    const n = await db.query(`select kind from notifications where user_id = $1`, [reporter.id]);
    expect(n.rows.map((x) => x.kind)).toContain('report');
    // 已处理列表里能看到说明
    await page.getByRole('button', { name: '已处理', exact: true }).click();
    await expect(page.locator(`[data-id="${rid}"]`).getByText(/处理说明：广告引流/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('批量驳回：勾选两条 → 批量操作条 → 驳回', async ({ page, db, makeUser, signIn }) => {
    const author = await makeUser(uniq('作者'));
    const r1 = await makeUser(uniq('举报人'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const tid = await seedThread(db, author.id);
    const rep = await seedReply(db, author.id, tid, '被举报的回复');
    const ids = [
      await report(db, r1.id, 'thread', tid, 'other'),
      await report(db, r1.id, 'reply', rep, 'abuse'),
    ];
    await signIn(page, m);
    await page.goto('/admin/reports/');
    for (const id of ids) await page.locator(`[data-id="${id}"] input[data-select]`).check();
    const bar = page.locator('[data-bulkbar]');
    await expect(bar).toBeVisible();
    await expect(bar.getByText('已选 2 项')).toBeVisible();
    await bar.getByRole('button', { name: '批量驳回' }).click();
    await dialog(page).getByRole('button', { name: '驳回' }).click();
    await expect(page.getByText('已处理 2 条举报。')).toBeVisible();
    const r = await db.query(`select distinct status from reports where id = any($1)`, [ids]);
    expect(r.rows).toEqual([{ status: 'dismissed' }]);
    await expect(bar).toBeHidden();
  });

  test('更多处理：封禁作者 7 天（键盘操作对话框）', async ({ page, db, makeUser, signIn }) => {
    const author = await makeUser(uniq('刷屏'));
    const r1 = await makeUser(uniq('举报人'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const tid = await seedThread(db, author.id);
    const rid = await report(db, r1.id, 'thread', tid);
    await signIn(page, m);
    await page.goto('/admin/reports/');
    await page.locator(`[data-id="${rid}"]`).getByRole('button', { name: '更多处理…' }).click();
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: '处理举报' })).toBeVisible();
    // 焦点在第一个控件上；Esc 可关闭
    await expect(d.getByLabel('处理方式')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await page.locator(`[data-id="${rid}"]`).getByRole('button', { name: '更多处理…' }).click();
    await d.getByLabel('处理方式').selectOption('ban');
    await expect(d.getByLabel('封禁时长')).toBeVisible();
    await d.getByLabel('封禁时长').selectOption('7');
    await d.getByLabel('处理说明').fill('连续发广告');
    await d.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('举报已处理。')).toBeVisible();
    const b = await db.query(
      `select p.banned, b.reason, round(extract(epoch from b.expires_at - b.created_at) / 86400) as days
       from profiles p join user_bans b on b.user_id = p.id and b.lifted_at is null where p.id = $1`,
      [author.id],
    );
    expect(b.rows[0]).toEqual({ banned: true, reason: '连续发广告', days: '7' });
  });
});

test.describe('内容管理', () => {
  test('搜索 → 隐藏 → 恢复（回到待审）→ 发布 → 置顶 → 删除（确认框）', async ({
    page,
    db,
    makeUser,
    signIn,
    errors,
  }) => {
    const author = await makeUser(uniq('作者'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const title = uniq('后台内容 ');
    const tid = await seedThread(db, author.id, { title, cat: '产品讨论' });
    await signIn(page, m);
    await page.goto('/admin/content/');
    // 等首屏列表加载完再输入（首屏 load 会按地址栏回填筛选项）
    await expect(page.locator('tbody[data-rows]')).not.toHaveAttribute('aria-busy', 'true');
    await page.locator('[data-filters]').getByLabel('搜索').fill(title);
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page).toHaveURL(/q=/);
    const row = page.locator(`tr[data-id="${tid}"]`);
    await expect(row).toBeVisible();
    await expect(page.locator('tbody[data-rows] tr')).toHaveCount(1);
    // 分类是次要列（data-priority=3，< 1200 隐藏），只断言存在
    await expect(row.getByText('产品讨论')).toBeAttached();
    await row.getByRole('button', { name: '隐藏' }).click();
    await expect(row.getByText('已隐藏', { exact: true })).toBeVisible();
    expect(
      (await db.query(`select published from forum_threads where id = $1`, [tid])).rows[0].published,
    ).toBe(false);
    // 「已隐藏」筛选
    await page.getByLabel('状态').selectOption('1');
    await expect(row).toBeVisible();
    // 站长 2026-10-27 21:06：恢复 = 回到「待审」，仍不公开（行留在「已隐藏」筛选里），主按钮变成显式「发布」
    await row.getByRole('button', { name: '恢复' }).click();
    await expect(row.getByText('待审', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: '发布' })).toBeVisible();
    expect(
      (await db.query(`select published from forum_threads where id = $1`, [tid])).rows[0].published,
    ).toBe(false);
    await row.getByRole('button', { name: '发布' }).click();
    await expect(row).toHaveCount(0);
    expect(
      (await db.query(`select published from forum_threads where id = $1`, [tid])).rows[0].published,
    ).toBe(true);
    await page.getByLabel('状态').selectOption('');
    await expect(row.getByText('已发布')).toBeVisible();
    // 次要操作在「⋯」菜单里（T9.16）：键盘可达，Esc 关闭并把焦点还给按钮
    const menuBtn = row.getByRole('button', { name: '更多操作' });
    await menuBtn.click();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: '置顶' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menuBtn).toBeFocused();
    await expect(page.getByRole('menu')).toBeHidden();
    await menuBtn.click();
    await page.getByRole('menuitem', { name: '置顶' }).click();
    await expect(row.getByText('置顶', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '删除…' }).click();
    await expect(dialog(page)).toContainText('永久删除');
    await dialog(page).getByRole('button', { name: '删除' }).click();
    await expect(row).toHaveCount(0);
    expect((await db.query(`select count(*)::int n from forum_threads where id = $1`, [tid])).rows[0].n).toBe(
      0,
    );
    const audit = await db.query(`select action from audit_log where target_id = $1 order by id`, [tid]);
    // 0018：隐藏 / 恢复走统一状态接口 mod_set_visibility，除行级 thread.update 外再记一条 content.visibility（含工作流状态与是否取消排程）
    // 0019：恢复只回到待审（公开标志不变 → 没有 thread.update，只有 content.visibility）；
    //       发布走 mod_publish_content → thread.update + content.published
    expect(audit.rows.map((x) => x.action)).toEqual([
      'thread.update',
      'content.visibility',
      'content.visibility',
      'thread.update',
      'content.published',
      'thread.update',
      'thread.delete',
    ]);
    expect(errors).toEqual([]);
  });

  test('回复 / 评论表：作者筛选（来自用户详情）+ 批量隐藏', async ({ page, db, makeUser, signIn }) => {
    const author = await makeUser(uniq('作者'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const tid = await seedThread(db, author.id);
    const r1 = await seedReply(db, author.id, tid, uniq('回复一 '));
    const r2 = await seedReply(db, author.id, tid, uniq('回复二 '));
    await signIn(page, m);
    await page.goto(`/admin/content/?type=reply&author=${author.id}`);
    await expect(page.getByText(`作者：${author.name}`)).toBeVisible();
    await expect(page.locator('tbody[data-rows] tr[data-id]')).toHaveCount(2);
    await page.getByRole('checkbox', { name: '全选本页' }).check();
    await page.locator('[data-bulkbar]').getByRole('button', { name: '隐藏' }).click();
    // 0018：批量隐藏返回逐项结果——结果面板摘要与提示都改为「已隐藏 N 条。」（旧库无逐项结果时仍是「已处理 N 条。」）
    await expect(page.locator('[data-bulk-summary]')).toHaveText('已隐藏 2 条。');
    await expect(page.locator('.toast', { hasText: '已隐藏 2 条。' })).toBeVisible();
    const r = await db.query(`select bool_or(published) p from forum_replies where id = any($1)`, [[r1, r2]]);
    expect(r.rows[0].p).toBe(false);
    // 0019：批量「恢复」只回到待审（仍不公开）；批量「发布」才公开
    await page.getByRole('checkbox', { name: '全选本页' }).check();
    await page.locator('[data-bulkbar]').getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('[data-bulk-summary]')).toHaveText('已恢复 2 条。');
    const restored = await db.query(
      `select bool_or(t.published) p, array_agg(distinct w.status) s from forum_replies t
         join content_workflow w on w.target_type = 'reply' and w.target_id = t.id where t.id = any($1)`,
      [[r1, r2]],
    );
    expect(restored.rows[0]).toEqual({ p: false, s: ['review'] });
    await page.getByRole('checkbox', { name: '全选本页' }).check();
    await page.locator('[data-bulkbar]').getByRole('button', { name: '发布' }).click();
    await expect(page.locator('[data-bulk-summary]')).toHaveText('已发布 2 条。');
    const pub = await db.query(`select bool_and(published) p from forum_replies where id = any($1)`, [
      [r1, r2],
    ]);
    expect(pub.rows[0].p).toBe(true);
  });
});

test.describe('内容流程 / 服务端排序 / 备注 / 版本（0017）', () => {
  test('表头排序走服务端；抽屉：转草稿 → 定时发布、版本对比、备注', async ({
    page,
    db,
    makeUser,
    signIn,
    errors,
  }) => {
    const author = await makeUser(uniq('作者'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const title = uniq('流程主题 ');
    const tid = await seedThread(db, author.id, { title });
    await db.query(`update forum_threads set body = body || E'\\n第二段' where id = $1`, [tid]);
    await signIn(page, m);
    await page.goto(`/admin/content/?q=${encodeURIComponent(title)}`);
    const row = page.locator(`tr[data-id="${tid}"]`);
    await expect(row).toBeVisible();
    // 服务端排序：点「内容」表头 → 请求带 p_sort=title（窄屏 < 900 表格是卡片布局，表头只剩 1×1 的读屏占位：
    // isVisible() 仍为真但点不到，所以按 thead 的实际高度判断（th 自身在 1×1 的 thead 里仍量得 40px 高），只在有可见表头时验证）
    const sortTh = page.locator('th[data-sort-key="title"] .th-sort');
    const headH = await page
      .locator('th[data-sort-key="title"]')
      .evaluate((el) => (el.closest('thead') ?? el).getBoundingClientRect().height)
      .catch(() => 0);
    if (headH > 8 && (await sortTh.isVisible())) {
      const req = page.waitForRequest(
        (r) => /rpc\/mod_list_content/.test(r.url()) && (r.postData() ?? '').includes('"p_sort":"title"'),
      );
      await sortTh.click();
      await req;
      await expect(page.locator('th[data-sort-key="title"]')).toHaveAttribute('aria-sort', 'ascending');
    }
    await expect(row).toBeVisible();
    // 抽屉
    await row.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '详情 / 预览 / 版本…' }).click();
    const d = page.locator('dialog[data-drawer][open]');
    await expect(d.getByRole('heading', { name: '主题详情' })).toBeVisible();
    await expect(d.locator('[data-preview-body]')).toContainText('第二段');
    await expect(d.locator('.diff__line--add')).toContainText('第二段');
    await d.getByLabel('状态', { exact: true }).selectOption('draft');
    await d.getByRole('button', { name: '更新状态' }).click();
    await expect(page.getByText('已改为「草稿」。')).toBeVisible();
    expect(
      (await db.query(`select published from forum_threads where id = $1`, [tid])).rows[0].published,
    ).toBe(false);
    await d.getByLabel('状态', { exact: true }).selectOption('review');
    const at = new Date(Date.now() + 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    await d
      .getByLabel('定时发布（可选）')
      .fill(`${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T09:30`);
    await d.getByRole('button', { name: '更新状态' }).click();
    await expect(page.getByText(/已设为定时发布/)).toBeVisible();
    const wf = await db.query(`select status, scheduled_at from content_workflow where target_id = $1`, [
      tid,
    ]);
    expect(wf.rows[0].status).toBe('review');
    expect(wf.rows[0].scheduled_at).not.toBeNull();
    // 备注
    await d.getByLabel('新备注').fill('E2E 备注：等作者补充来源');
    await d.getByRole('button', { name: '添加备注' }).click();
    await expect(d.locator('[data-notes]')).toContainText('等作者补充来源');
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(row.locator('[data-wf="review"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('用户画像：分群、标签、近期发布；管理员可打开邮件草稿（只预览）', async ({
    page,
    makeUser,
    signIn,
    db,
    errors,
  }) => {
    const a = await makeUser(uniq('站长'), { role: 'admin' });
    const u = await makeUser(uniq('画像'));
    await seedThread(db, u.id, { title: uniq('画像主题 ') });
    await signIn(page, a);
    await page.goto(`/admin/users/view/?id=${u.id}`);
    await expect(page.getByRole('heading', { name: '分群与标签' })).toBeVisible();
    await expect(page.locator('[data-segment="new"]')).toBeVisible();
    await page.getByLabel('新标签').fill('种子用户');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.locator('[data-tags]')).toContainText('种子用户');
    await expect(page.locator('[data-posts] li')).toHaveCount(1);
    await expect(page.getByText('未订阅')).toBeVisible();
    await page.goto(`/admin/users/?q=${encodeURIComponent(u.name)}`);
    await expect(page.getByRole('link', { name: u.name })).toBeVisible();
    await page.getByRole('button', { name: '邮件草稿（本页）' }).click();
    await expect(dialog(page)).toContainText('后台不会发送任何邮件');
    await expect(dialog(page).locator('.mail-preview__body')).toContainText(`${u.name}，你好`);
    await dialog(page).getByRole('button', { name: '取消' }).click();
    expect(errors).toEqual([]);
  });
});

test.describe('用户管理', () => {
  test('管理员：搜索用户 → 详情 → 改为版主；自己的角色不可修改', async ({
    page,
    db,
    makeUser,
    signIn,
    errors,
  }) => {
    const a = await makeUser(uniq('站长'), { role: 'admin' });
    const u = await makeUser(uniq('候选版主'));
    await signIn(page, a);
    await page.goto('/admin/users/');
    await page.locator('[data-filters]').getByLabel('搜索').fill(u.name);
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page.getByRole('link', { name: u.name })).toBeVisible();
    // 管理员能看到邮箱
    await expect(page.getByText(u.email)).toBeVisible();
    await page.getByRole('link', { name: u.name }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/view/\\?id=${u.id}`));
    await page.getByRole('combobox', { name: '角色' }).selectOption('moderator');
    await page.getByRole('button', { name: '保存角色' }).click();
    await expect(page.locator('[data-role]')).toHaveText('版主');
    expect((await db.query(`select role from profiles where id = $1`, [u.id])).rows[0].role).toBe(
      'moderator',
    );
    await page.goto(`/admin/users/view/?id=${a.id}`);
    await expect(page.getByRole('combobox', { name: '角色' })).toBeDisabled();
    await expect(page.getByText('不能修改自己的角色')).toBeVisible();
    await expect(page.getByText('不能封禁自己。')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('版主：封禁（原因 + 时长）→ 封禁记录 → 解封；不能封禁管理员', async ({
    page,
    db,
    makeUser,
    signIn,
  }) => {
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const u = await makeUser(uniq('违规者'));
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await signIn(page, m);
    await page.goto(`/admin/users/view/?id=${u.id}`);
    // 版主看不到邮箱，也不能改角色
    await expect(page.getByText(u.email)).toHaveCount(0);
    await expect(page.getByText('只有管理员可以修改角色')).toBeVisible();
    await page.getByLabel('原因').fill('多次辱骂');
    await page.getByLabel('时长').selectOption('3');
    await page.getByRole('button', { name: '封禁', exact: true }).click();
    await expect(page.locator('[data-ban-state]')).toHaveText(/封禁至/);
    await expect(page.getByRole('region', { name: '封禁记录' }).getByText('多次辱骂')).toBeVisible();
    const n = await db.query(
      `select excerpt from notifications where user_id = $1 order by id desc limit 1`,
      [u.id],
    );
    expect(n.rows[0].excerpt).toMatch(/限制发言.*多次辱骂/);
    await page.getByRole('button', { name: '解除封禁' }).click();
    await dialog(page).getByLabel('解封说明（选填，写入审计日志）').fill('申诉通过');
    await dialog(page).getByRole('button', { name: '解除封禁' }).click();
    await expect(page.locator('[data-ban-state]')).toHaveText('正常');
    expect(
      (await db.query(`select lift_reason from user_bans where user_id = $1`, [u.id])).rows[0].lift_reason,
    ).toBe('申诉通过');
    // 警告
    await page.getByLabel('提醒内容').fill('请注意言辞');
    await page.getByRole('button', { name: '发送警告' }).click();
    await expect(page.getByText('警告已发送。')).toBeVisible();
    await page.goto(`/admin/users/view/?id=${a.id}`);
    await expect(page.getByText('只有管理员可以封禁或解封版主 / 管理员。')).toBeVisible();
  });
});

test.describe('审计日志', () => {
  test('管理员按动作筛选、导出 CSV（含中文与表头）', async ({ page, db, makeUser, signIn }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    const u = await makeUser(uniq('被改角色'));
    await db.query(
      `insert into audit_log (actor, actor_role, action, target_type, target_id, detail) values ($1, 'admin', 'user.ban', 'profile', $2, '{"reason":"E2E 审计","expires_at":null}')`,
      [a.id, u.id],
    );
    await signIn(page, a);
    await page.goto(`/admin/audit/?target=${u.id}`);
    const row = page.locator('tbody[data-rows] tr').first();
    await expect(row.getByText('封禁用户')).toBeVisible();
    // 详情是次要列（data-priority=3，< 1200 隐藏），只断言存在
    await expect(row.getByText('原因：E2E 审计')).toBeAttached();
    await expect(row.getByRole('link', { name: a.name })).toBeVisible();
    await page.getByLabel('动作').selectOption('report.');
    await expect(page.getByText('没有符合条件的记录', { exact: true })).toBeVisible();
    await page.getByLabel('动作').selectOption('user.');
    await expect(row.getByText('封禁用户')).toBeVisible();
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出 CSV' }).click(),
    ]);
    expect(dl.suggestedFilename()).toMatch(/^audit-log-.*\.csv$/);
    const csv = readFileSync((await dl.path())!, 'utf8');
    expect(csv.startsWith('\uFEFFid,created_at,actor,actor_name')).toBe(true);
    expect(csv).toContain('E2E 审计');
    expect(csv).toContain(a.name);
  });
});

test.describe('站点设置（全局状态：串行，只在桌面视口跑）', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({ db: _db }, info) => {
    void _db;
    test.skip(!info.project.name.endsWith('-desktop'), '站点设置是全局的，避免与其他视口的同一用例互相覆盖');
  });

  test('导入设置 JSON（校验 + 预览 + 确认）', async ({ page, db, makeUser, signIn }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await signIn(page, a);
    await page.goto('/admin/data/');
    try {
      const file = page.getByLabel('导入设置（JSON 文件）');
      await file.setInputFiles({
        name: 'bad.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"admin":{}}'),
      });
      await expect(page.getByText('未知的设置项「admin」')).toBeVisible();
      await expect(page.getByRole('button', { name: '确认导入' })).toBeDisabled();
      await file.setInputFiles({
        name: 'settings.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            settings: [{ slug: 'registration', data: { open: true, message: 'E2E 导入' } }],
          }),
        ),
      });
      await expect(page.locator('[data-import-list]')).toContainText('注册');
      await page.getByRole('button', { name: '确认导入' }).click();
      await expect(page.getByText('已导入 1 项设置。')).toBeVisible();
      const row = await db.query(
        `select data from site_content where kind = 'setting' and slug = 'registration'`,
      );
      expect(row.rows[0].data).toEqual({ open: true, message: 'E2E 导入' });
    } finally {
      await db.query(`delete from site_content where kind = 'setting' and slug = 'registration'`);
    }
  });

  test('启用公告 → 公开页面显示公告条（可关闭）；关闭注册 → 注册页显示说明', async ({
    page,
    db,
    makeUser,
    signIn,
  }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    const text = uniq('E2E 公告 ');
    try {
      await signIn(page, a);
      await page.goto('/admin/settings/');
      const ann = page.locator('form[data-setting="announcement"]');
      await ann.getByRole('switch', { name: '在所有公开页面显示公告条' }).check();
      await ann.getByLabel('公告内容').fill(text);
      await ann.getByLabel('链接（选填）').fill('javascript:alert(1)');
      await ann.getByRole('button', { name: '保存公告' }).click();
      await expect(ann.getByText('链接只能是站内路径')).toBeVisible();
      await ann.getByLabel('链接（选填）').fill('/changelog/');
      await ann.getByLabel('链接文字').fill('查看更新');
      await ann.getByRole('button', { name: '保存公告' }).click();
      await expect(ann.getByText('已保存。')).toBeVisible();
      const reg = page.locator('form[data-setting="registration"]');
      await reg.getByRole('switch', { name: '开放新用户注册' }).uncheck();
      await reg.getByLabel('关闭注册时的说明（选填）').fill('系统维护中，暂停注册');
      await reg.getByRole('button', { name: '保存注册设置' }).click();
      await expect(reg.getByText('已保存。')).toBeVisible();
      const row = await db.query(
        `select data from site_content where kind = 'setting' and slug = 'announcement'`,
      );
      expect(row.rows[0].data).toMatchObject({
        enabled: true,
        text,
        link: '/changelog/',
        linkText: '查看更新',
      });
      // 设置的审计
      expect(
        (
          await db.query(
            `select count(*)::int n from audit_log where target_id = 'setting:registration' and actor = $1`,
            [a.id],
          )
        ).rows[0].n,
      ).toBeGreaterThan(0);

      await useRealSettings(page);
      await page.goto('/about/');
      const banner = page.getByRole('complementary', { name: '站点公告' });
      await expect(banner).toContainText(text);
      await expect(banner.getByRole('link', { name: '查看更新' })).toHaveAttribute('href', '/changelog/');
      await banner.getByRole('button', { name: '关闭公告' }).click();
      await expect(banner).toHaveCount(0);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('complementary', { name: '站点公告' })).toHaveCount(0);

      await page.goto('/register/');
      await expect(page.getByText('系统维护中，暂停注册')).toBeVisible();
      await expect(page.locator('form[data-auth-form="register"]')).toBeHidden();
    } finally {
      await db.query(
        `delete from site_content where kind = 'setting' and slug in ('announcement', 'registration')`,
      );
    }
  });

  test('论坛分类：调整顺序（键盘）并保存', async ({ page, db, makeUser, signIn }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    try {
      await signIn(page, a);
      await page.goto('/admin/settings/');
      const f = page.locator('form[data-setting="forum"]');
      await expect(f.locator('[data-cat]')).toHaveCount(4);
      const down = f.getByRole('button', { name: '下移「公告」' });
      await down.focus();
      await page.keyboard.press('Enter');
      await expect(f.getByRole('button', { name: '下移「公告」' })).toBeFocused();
      await f.getByRole('button', { name: '保存分类设置' }).click();
      await expect(f.getByText('已保存。')).toBeVisible();
      const row = await db.query(`select data from site_content where kind = 'setting' and slug = 'forum'`);
      expect(row.rows[0].data.categories.map((c: { id: string }) => c.id)).toEqual([
        'product',
        'announce',
        'tech',
        'meta',
      ]);
    } finally {
      await db.query(`delete from site_content where kind = 'setting' and slug = 'forum'`);
    }
  });
});

test.describe('导入导出 / 官方内容', () => {
  test('导出 JSON 不含邮箱', async ({ page, makeUser, signIn }) => {
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await signIn(page, a);
    await page.goto('/admin/data/');
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出全部（JSON）' }).click(),
    ]);
    const json = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
    expect(Object.keys(json)).toEqual(
      expect.arrayContaining(['forum_threads', 'forum_replies', 'comments', 'profiles']),
    );
    expect(json.profiles.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain('@example.com');
    expect(json.profiles[0]).not.toHaveProperty('email');
    await expect(page.getByText(/已导出：主题 \d+/)).toBeVisible();
  });

  test('官方内容：只读清单，链接到 GitHub 编辑页', async ({ page, makeUser, signIn }) => {
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    await signIn(page, m);
    await page.goto('/admin/official/');
    await expect(body(page)).toBeVisible();
    const edit = page.getByRole('link', { name: '在 GitHub 编辑：FableMotion（新窗口）', exact: true });
    await expect(edit).toHaveAttribute(
      'href',
      'https://github.com/azsou/azsou-site/edit/main/src/content/apps/fablemotion.md',
    );
    await expect(edit).toHaveAttribute('target', '_blank');
    // 文章数随内容增加（P8 新增原创文章），按内容目录实际数量核对
    const articleCount = readdirSync('src/content/articles').filter((f) => f.endsWith('.md')).length;
    await expect(page.getByRole('heading', { name: `文章（${articleCount}）` })).toBeVisible();
  });
});

test.describe('@提及', () => {
  test('回复里 @昵称 → 被提及者的通知页出现「提到了你」并链接到回复', async ({
    page,
    browser,
    db,
    makeUser,
    signIn,
  }) => {
    const author = await makeUser(uniq('楼主'));
    const target = await makeUser(uniq('被提及'));
    const writer = await makeUser(uniq('回帖人'));
    const tid = await seedThread(db, author.id);
    await signIn(page, writer);
    await page.goto(`/forum/t/?id=${tid}`);
    await expect(page.locator('h1')).not.toHaveText('正在加载主题…');
    await page.getByLabel('写回复').fill(`@${target.name} 你怎么看？`);
    await page.getByRole('button', { name: '发布回复' }).click();
    await expect(page.locator('[data-list] li.post', { hasText: '你怎么看？' })).toBeVisible();
    const n = await db.query(`select kind, thread_key from notifications where user_id = $1`, [target.id]);
    expect(n.rows).toEqual([{ kind: 'mention', thread_key: tid }]);

    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      serviceWorkers: 'block',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const p2 = await ctx.newPage();
    await forwardRest(p2);
    await signIn(p2, target);
    await p2.goto('/notifications/');
    const item = p2.locator('[data-list] li', { hasText: '提到了你' });
    await expect(item).toContainText(writer.name);
    await expect(item.getByRole('link')).toHaveAttribute('href', new RegExp(`/forum/t/\\?id=${tid}#r-`));
    await ctx.close();
  });
});

test.describe('暗色模式 / 窄屏 / 无障碍', () => {
  test('举报队列、内容表、用户详情、设置页在暗色模式下 axe 无违规', async ({
    page,
    db,
    makeUser,
    signIn,
  }) => {
    test.setTimeout(120_000);
    await emulateColorScheme(page, 'dark');
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    const u = await makeUser(uniq('用户'));
    const tid = await seedThread(db, u.id);
    await report(db, a.id, 'thread', tid);
    await signIn(page, a);
    for (const path of [
      '/admin/reports/',
      '/admin/content/',
      `/admin/users/view/?id=${u.id}`,
      '/admin/settings/',
      '/admin/audit/',
      '/admin/data/',
      '/admin/guestbook/',
      '/admin/links/',
    ]) {
      await page.goto(path);
      await expect(body(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await axe(page), path).toEqual([]);
    }
  });

  test('窄屏卡片表：Tab 不停在视觉隐藏的表头，排序走工具条下拉；导入导出卡片不超出视口', async ({
    page,
    makeUser,
    signIn,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 900 });
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await makeUser(uniq('用户'));
    await signIn(page, a);
    await page.goto('/admin/users/');
    await expect(page.locator('.data-table tbody tr[data-row]').first()).toBeVisible();
    // 焦点逐个检查：不能落在表头里，表格内的焦点要完整落在滚动容器的可视区内；
    // 每一站都必须是真实可见的控件。Tab 合法离开页面（落到 BODY）时结束循环，不算失败。
    await page.locator('.table-tools button').first().focus();
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        if (!e || e === document.body) return null;
        const wrap = e.closest('.table-wrap');
        const b = e.getBoundingClientRect();
        const w = wrap?.getBoundingClientRect();
        return {
          thead: !!e.closest('thead'),
          inside: !w || (b.left >= w.left - 1 && b.right <= w.right + 1),
          visible: b.width > 0 && b.height > 0 && e.checkVisibility({ visibilityProperty: true }),
          label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 20),
        };
      });
      if (!f) break;
      expect(f.thead, f.label).toBe(false);
      expect(f.inside, f.label).toBe(true);
      expect(f.visible, f.label).toBe(true);
    }
    const sort = page.locator('.table-tools__sort select');
    await expect(sort).toBeVisible();
    const sortReq = () => page.waitForRequest((r) => /mod_list_users/.test(r.url()) && r.method() === 'POST');
    let req = sortReq();
    await sort.selectOption({ index: 1 });
    let body = JSON.parse((await req).postData() ?? '{}');
    expect([body.p_sort, body.p_dir]).toEqual([expect.any(String), 'asc']);
    await expect(page.locator('thead th[aria-sort="ascending"]')).toHaveCount(1);
    req = sortReq();
    await sort.selectOption({ index: 2 });
    body = JSON.parse((await req).postData() ?? '{}');
    expect(body.p_dir).toBe('desc');
    await expect(page.locator('thead th[aria-sort="descending"]')).toHaveCount(1);
    // 默认顺序：请求不再带排序参数（或为 null），表头无 aria-sort
    req = sortReq();
    await sort.selectOption('');
    body = JSON.parse((await req).postData() ?? '{}');
    expect(body.p_sort ?? null).toBeNull();
    await expect(page.locator('thead th[aria-sort]')).toHaveCount(0);

    await page.goto('/admin/data/');
    await expect(page.locator('[data-export-csv="comments"]')).toBeVisible();
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const pre = document.querySelector('pre.code-block') as HTMLElement;
      return {
        overflow: document.documentElement.scrollWidth - vw,
        clipped: [...document.querySelectorAll('main button, main input')]
          .filter((e) => e.getBoundingClientRect().right > vw + 1)
          .map((e) => e.textContent?.trim() || (e as HTMLInputElement).type),
        preInside: pre.getBoundingClientRect().right <= vw + 1,
        preScrolls: pre.scrollWidth > pre.clientWidth,
      };
    });
    expect(m).toEqual({ overflow: 0, clipped: [], preInside: true, preScrolls: true });
  });

  test('断点交接：焦点从排序下拉回到宽屏时只落在可见控件；隐藏列不丢焦点、不改排序、不发请求', async ({
    page,
    makeUser,
    signIn,
  }) => {
    test.setTimeout(90_000);
    const a = await makeUser(uniq('管理员'), { role: 'admin' });
    await makeUser(uniq('用户'));
    await signIn(page, a);
    const focusState = () =>
      page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        if (!e || e === document.body) return { body: true } as const;
        const b = e.getBoundingClientRect();
        // 祖先裁切：沿 overflow 非 visible 的祖先检查交集
        let clipped = false;
        for (let p = e.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
            const r = p.getBoundingClientRect();
            if (b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom)
              clipped = true;
          }
        }
        return {
          body: false,
          visible: b.width > 0 && b.height > 0 && e.checkVisibility({ visibilityProperty: true }),
          clipped,
          where: e.closest('thead')
            ? 'thead'
            : e.closest('.table-tools')
              ? 'tools'
              : e.closest('tbody')
                ? 'tbody'
                : 'other',
          col: e.getAttribute('data-sort-col'),
          tag: e.tagName,
        };
      });
    const sort = page.locator('.table-tools__sort select');
    const rpc: string[] = [];
    page.on('request', (r) => {
      if (/mod_list_users/.test(r.url())) rpc.push(r.postData() ?? '');
    });
    const choose = async (value: string) => {
      const req = page.waitForRequest((r) => /mod_list_users/.test(r.url()) && r.method() === 'POST');
      await sort.selectOption(value);
      await req;
      await expect(page.locator('.data-table tbody tr[data-row]').first()).toBeVisible();
    };

    // 正常对照：可见列（第 1 列「用户」）800 → 1440，焦点交给该列表头按钮
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto('/admin/users/');
    await expect(page.locator('.data-table tbody tr[data-row]').first()).toBeVisible();
    await choose('1:ascending');
    await sort.focus();
    let n = rpc.length;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(async () => (await focusState()).body === false && (await focusState()).where)
      .toBe('thead');
    let f = await focusState();
    expect(f).toMatchObject({ body: false, visible: true, clipped: false, where: 'thead', col: '1' });
    expect(rpc.length).toBe(n);
    // 宽 → 窄：焦点在表头，交给可见下拉
    await page.setViewportSize({ width: 800, height: 900 });
    await expect.poll(async () => (await focusState()).where).toBe('tools');
    f = await focusState();
    expect(f).toMatchObject({ body: false, visible: true, clipped: false, tag: 'SELECT' });

    // 路径 A：响应式隐藏列（注册时间，data-priority=3，<1200 隐藏）800 → 1000
    await choose('8:ascending');
    await sort.focus();
    n = rpc.length;
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await focusState()).body).toBe(false);
    f = await focusState();
    expect(f).toMatchObject({ body: false, visible: true, clipped: false });
    expect(f.col).not.toBe('8');
    await expect(page.locator('thead th:nth-child(8)')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('thead th:nth-child(8)')).toBeHidden();
    expect(rpc.length).toBe(n);
    // 1000 → 800 → 1000 再来一次（来回切换）
    await page.setViewportSize({ width: 800, height: 900 });
    await sort.focus();
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(async () => (await focusState()).body).toBe(false);
    expect(await focusState()).toMatchObject({ visible: true, clipped: false });
    expect(rpc.length).toBe(n);

    // 路径 B：用户隐藏「状态」列（第 3 列）800 → 1440
    await page.setViewportSize({ width: 800, height: 900 });
    await page.evaluate(() => {
      const k = 'az-admin-table:users';
      const p = JSON.parse(localStorage.getItem(k) || '{}');
      localStorage.setItem(k, JSON.stringify({ ...p, hide: [3], sort: null }));
    });
    await page.reload();
    await expect(page.locator('.data-table tbody tr[data-row]').first()).toBeVisible();
    await expect(page.locator('table.data-table')).toHaveAttribute('data-hide', /\b3\b/);
    await choose('3:ascending');
    await sort.focus();
    n = rpc.length;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await focusState()).body).toBe(false);
    f = await focusState();
    expect(f).toMatchObject({ body: false, visible: true, clipped: false });
    expect(f.col).not.toBe('3');
    await expect(page.locator('table.data-table')).toHaveAttribute('data-hide', /\b3\b/);
    await expect(page.locator('thead th:nth-child(3)')).toHaveAttribute('aria-sort', 'ascending');
    await expect(sort).toHaveValue('3:ascending');
    expect(rpc.length).toBe(n);

    // 焦点在行内按钮：断点来回切换不移动它
    const rowBtn = page
      .locator('.data-table tbody tr[data-row] button, .data-table tbody tr[data-row] a')
      .first();
    await rowBtn.focus();
    const before = await rowBtn.evaluate((e) => e.outerHTML);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(before);
  });
});
