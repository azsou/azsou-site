import { readdirSync, readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { emulateColorScheme } from './fixtures';
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
  test('搜索 → 隐藏 → 恢复 → 置顶 → 删除（确认框）', async ({ page, db, makeUser, signIn, errors }) => {
    const author = await makeUser(uniq('作者'));
    const m = await makeUser(uniq('版主'), { role: 'moderator' });
    const title = uniq('后台内容 ');
    const tid = await seedThread(db, author.id, { title, cat: '产品讨论' });
    await signIn(page, m);
    await page.goto('/admin/content/');
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
    await row.getByRole('button', { name: '恢复' }).click();
    await expect(row).toHaveCount(0);
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
    expect(audit.rows.map((x) => x.action)).toEqual([
      'thread.update',
      'thread.update',
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
    await expect(page.getByText('已处理 2 条。')).toBeVisible();
    const r = await db.query(`select bool_or(published) p from forum_replies where id = any($1)`, [[r1, r2]]);
    expect(r.rows[0].p).toBe(false);
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
      baseURL: 'http://127.0.0.1:4321',
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
});
