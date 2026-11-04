import { test, expect, uniq } from './community-fixtures';

/**
 * 发帖表单的两个「点下去时状态在变」问题（CI 偶发失败的根因，见 docs/audits/evidence/ci/images-flake-2026-10-28.md）：
 *  1. 宽屏并排时预览 200ms 防抖渲染后变高，把「发布主题」往下推——点击落在按钮移走前的位置（#6 9f16831 处原来只加了等待）。
 *  2. 发布成功后按钮立刻恢复可用，而跳到新主题页在 WebKit / 慢机上要几秒：这段时间还能再提交。
 * 两条都断言应用自身的行为，不靠等待时长。
 */

test.describe('发帖表单稳定性', () => {
  test('宽屏：预览渲染出长正文后「发布主题」位置不变（预览在框内滚动，不撑高表单）', async ({
    page,
    makeUser,
    signIn,
  }) => {
    const u = await makeUser(uniq('布局'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    const modes = page.getByRole('group', { name: '视图' });
    await expect(page.locator('#nt-body')).toBeVisible();
    test.skip(await modes.isVisible(), '窄屏是「编辑 / 预览」切换，预览不与编辑区并排');

    const submit = page.getByRole('button', { name: '发布主题' });
    const body = page.locator('#nt-body');
    const preview = page.getByRole('region', { name: '预览' });
    // 先写一行、等预览渲染（页面其余部分——分类、站点设置——此时已稳定），记下按钮位置
    await body.fill('第一行');
    await expect(preview).toContainText('第一行');
    await expect(page.locator('.cat-picker')).toBeVisible();
    // 文档坐标（fill 会把光标滚进视口，视口坐标会随页面滚动变）
    const docY = () => submit.evaluate((b) => b.getBoundingClientRect().top + scrollY);
    const before = await docY();
    // 长正文：远高于编辑区的预览，200ms 防抖后渲染
    await body.fill(Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段`).join('\n\n'));
    await expect(preview).toContainText('第 80 段');
    const after = await docY();
    expect(Math.abs(after - before), `按钮从 y=${before} 移到 y=${after}`).toBeLessThanOrEqual(1);
    // 预览没有被截掉：在自己的框里能滚到底，且可用键盘聚焦（可滚动区域必须可聚焦）
    const scroll = await preview.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(scroll.sh).toBeGreaterThan(scroll.ch);
    await preview.focus();
    await expect(preview).toBeFocused();
  });

  test('发布成功到页面离开之间：按钮保持禁用，重复提交被忽略（不再闪出「正文不能为空」，不发第二次请求）', async ({
    page,
    db,
    makeUser,
    signIn,
  }) => {
    const u = await makeUser(uniq('锁定'));
    await signIn(page, u);
    await page.goto('/forum/new/?cat=tech');
    const title = uniq('提交锁 ');
    await page.getByLabel('标题').fill(title);
    await page.locator('#nt-body').fill('正文内容');

    // 新主题页的文档请求回 204（浏览器按规范不离开当前页）：页面停在「已发布、还没离开」的状态，可以检查表单（真实环境里这段时间是 1–8 秒的加载）
    let threadUrl = '';
    const THREAD_DOC = /\/forum\/t\/\?id=/;
    await page.route(THREAD_DOC, async (route) => {
      threadUrl = route.request().url();
      await route.fulfill({ status: 204 });
    });
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/rest\/v1\/forum_threads/.test(r.url())) posts.push(r.url());
    });

    const submit = page.getByRole('button', { name: '发布主题' });
    await submit.click();
    await expect.poll(() => threadUrl).toMatch(/\/forum\/t\/\?id=[0-9a-f-]{36}$/);
    // 文档请求被扣下期间 Playwright 的定位器会等「导航结束」，所以这里直接在页面里读状态
    const state = () =>
      page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>('[data-new-thread] button[type="submit"]')!;
        return {
          path: location.pathname,
          disabled: b.disabled,
          busy: b.getAttribute('aria-busy'),
          bodyError: document.querySelector('[data-error-for="body"]')!.textContent,
          status: document.querySelector('[data-form-status]')!.textContent,
        };
      });
    await expect.poll(async () => (await state()).path).toBe('/forum/new/');
    expect(await state()).toMatchObject({ disabled: true, busy: 'true' });
    // 双击 / Ctrl+Enter 的等价：再提交一次
    await page.evaluate(() =>
      document.querySelector<HTMLFormElement>('[data-new-thread] form')!.requestSubmit(),
    );
    await page.evaluate(() =>
      document
        .querySelector('#nt-body')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })),
    );
    expect(await state()).toMatchObject({ disabled: true, busy: 'true', bodyError: '', status: '' });
    expect(posts).toHaveLength(1);
    const n = await db.query('select count(*)::int as n from public.forum_threads where title = $1', [title]);
    expect(n.rows[0].n).toBe(1);

    // 主题确实已发布：直接打开能看到
    await page.unroute(THREAD_DOC);
    await page.goto(new URL(threadUrl).pathname + new URL(threadUrl).search);
    await expect(page.locator('h1')).toHaveText(title);
  });
});
