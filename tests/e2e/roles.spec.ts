import type { Page } from '@playwright/test';
import { test, expect, seedThread, uniq, type TestUser } from './community-fixtures';

/**
 * P5 全量回归：角色矩阵（匿名 / 普通用户 / 被封禁 / 版主 / 管理员）× 关键流程，
 * 在全部 3 个引擎 × 4 个视口（桌面 1440、iPad 834、iPhone 390、安卓 360）上跑，后端是真实 Postgres + PostgREST。
 *  - 浏览论坛与主题、发主题入口、回复框、举报、版主工具、通知页、管理后台权限门与菜单、顶栏「管理后台」入口。
 * 权限的「真」在数据库（tests/db/rls-matrix），这里验证每个角色在每种设备上看到的界面与能完成的操作。
 */
test.use({ allViewports: true });

type Role = 'anon' | 'user' | 'banned' | 'moderator' | 'admin';
const ROLES: Role[] = ['anon', 'user', 'banned', 'moderator', 'admin'];

const adminLinkVisible = (page: Page) =>
  page.locator('[data-admin-link]').evaluateAll((els) => els.some((e) => !(e as HTMLElement).hidden));

for (const role of ROLES) {
  test(`角色 ${role}：论坛、主题、发帖、通知、后台`, async ({ page, db, makeUser, signIn, errors }) => {
    const author = await makeUser(uniq('楼主'));
    const tid = await seedThread(db, author.id, { title: uniq(`角色矩阵 ${role} `) });
    if (role !== 'anon') {
      const me: TestUser = await makeUser(uniq(role), {
        role: role === 'moderator' || role === 'admin' ? role : 'user',
        banned: role === 'banned',
      });
      await signIn(page, me);
    }

    // 1) 主题页：所有人可读；回复框 / 举报 / 版主工具按角色出现
    await page.goto(`/forum/t/?id=${tid}`);
    await expect(page.locator('h1')).toContainText('角色矩阵');
    const replyBox = page.getByRole('textbox', { name: '写回复' });
    const modTools = page.getByRole('group', { name: '版主工具' });
    if (role === 'anon') {
      await expect(page.getByText('登录后即可回复。')).toBeVisible();
      await expect(replyBox).toHaveCount(0);
    } else if (role === 'banned') {
      await expect(page.getByText('你的账号已被限制发言。')).toBeVisible();
      await expect(replyBox).toHaveCount(0);
    } else {
      await expect(replyBox).toBeVisible();
      const text = `来自 ${role} 的回复 ${uniq()}`;
      await replyBox.fill(text);
      await page.getByRole('button', { name: '发布回复' }).click();
      await expect(page.locator('[data-replies-section] [data-list]').getByText(text)).toBeVisible();
    }
    if (role === 'moderator' || role === 'admin') {
      await expect(modTools).toBeVisible();
      await modTools.getByRole('button', { name: '置顶' }).click();
      await expect(modTools.getByRole('button', { name: '取消置顶' })).toBeVisible();
      const r = await db.query(`select pinned from public.forum_threads where id = $1`, [tid]);
      expect(r.rows[0].pinned).toBe(true);
    } else {
      await expect(modTools).toHaveCount(0);
    }

    // 2) 发主题页
    await page.goto('/forum/new/?cat=tech');
    if (role === 'anon') {
      await expect(page.getByRole('heading', { name: '登录后发帖' })).toBeVisible();
    } else if (role === 'banned') {
      await expect(page.getByText('你的账号已被限制发言，暂时不能发主题。')).toBeVisible();
    } else {
      await expect(page.locator('form[data-signed-in]')).toBeVisible();
      await expect(page.getByRole('button', { name: '插入图片' })).toBeVisible();
      // 「公告」只有管理员能选
      const announce = page.getByRole('radio', { name: '公告' });
      if (role === 'admin') await expect(announce).toBeVisible();
      else await expect(announce).toBeHidden();
    }

    // 3) 通知页
    await page.goto('/notifications/');
    if (role === 'anon')
      await expect(page.getByRole('link', { name: '登录', exact: true }).first()).toBeVisible();
    else await expect(page.locator('h1')).toBeVisible();

    // 4) 管理后台：权限门与菜单
    await page.goto('/admin/');
    const nav = page.getByRole('navigation', { name: '后台导航' });
    if (role === 'anon') {
      await expect(page.getByText('管理后台需要登录。')).toBeVisible();
    } else if (role === 'user' || role === 'banned') {
      await expect(
        page.getByText(
          role === 'banned' ? '你的账号已被限制，暂时不能使用管理后台。' : '你的账号没有访问管理后台的权限。',
        ),
      ).toBeVisible();
      await expect(page.locator('[data-admin-body]')).toBeHidden();
    } else {
      await expect(page.locator('[data-admin-body]')).toBeVisible();
      await expect(nav.getByRole('link', { name: '举报队列' })).toBeVisible();
      const audit = nav.getByRole('link', { name: '审计日志' });
      if (role === 'admin') await expect(audit).toBeVisible();
      else await expect(audit).toBeHidden();
    }
    // 管理员专属页：版主被挡
    if (role === 'moderator') {
      await page.goto('/admin/settings/');
      await expect(page.getByText('这个页面仅管理员可用。')).toBeVisible();
    }

    // 5) 顶栏「管理后台」入口只给版主 / 管理员
    await page.goto('/forum/');
    await page.waitForLoadState('networkidle');
    expect(await adminLinkVisible(page)).toBe(role === 'moderator' || role === 'admin');

    // 无横向溢出
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}
