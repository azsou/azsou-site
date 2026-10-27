import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * 账户流程（GoTrue / PostgREST / 站内 Turnstile 端点全部用假实现，结果可复现）：
 * 登录、注册（含 Turnstile token 透传）、找回密码、邮件回调、OAuth（PKCE）、设置页、顶栏用户菜单、退出。
 */
const USER = {
  id: '9b2c1a10-0000-4000-8000-0000000000aa',
  email: 'alice@example.com',
  email_confirmed_at: '2026-10-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: { name: 'Alice' },
};
const tokens = (user: Record<string, unknown> = USER) => ({
  access_token: 'jwt-access',
  refresh_token: 'jwt-refresh',
  expires_in: 3600,
  token_type: 'bearer',
  user,
});

interface AuthMock {
  calls: { url: string; method: string; body: unknown }[];
  profileName: string;
}

async function mockAuth(page: Page, opts: { confirmed?: boolean } = {}): Promise<AuthMock> {
  const state: AuthMock = { calls: [], profileName: 'Alice' };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const record = (route: Route) => {
    const r = route.request();
    let body: unknown;
    try {
      body = r.postDataJSON();
    } catch {
      body = r.postData();
    }
    state.calls.push({ url: r.url(), method: r.method(), body });
  };
  await page.route('**/auth/v1/**', async (route) => {
    record(route);
    const u = new URL(route.request().url());
    const path = u.pathname.replace('/auth/v1/', '');
    const body = (state.calls.at(-1)!.body ?? {}) as Record<string, string>;
    if (path === 'token' && u.searchParams.get('grant_type') === 'password') {
      if (body.password !== 'Passw0rd!')
        return json(route, 400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        });
      if (opts.confirmed === false)
        return json(route, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return json(route, 200, tokens());
    }
    if (path === 'token' && u.searchParams.get('grant_type') === 'pkce') {
      return json(route, 200, tokens({ ...USER, app_metadata: { provider: 'github' } }));
    }
    if (path === 'user' && route.request().method() === 'GET') return json(route, 200, USER);
    if (path === 'user' && route.request().method() === 'PUT') return json(route, 200, USER);
    if (path === 'logout') return route.fulfill({ status: 204 });
    if (path === 'authorize') {
      // 模拟提供方授权后回跳到本站回调页（PKCE：?code=）
      const to = new URL(u.searchParams.get('redirect_to')!);
      to.searchParams.set('code', 'oauth-code-1');
      // WebKit 不支持用 3xx fulfill 导航请求，改用一个立即跳转的页面
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><script>location.replace(${JSON.stringify(to.toString())})</script>`,
      });
    }
    return json(route, 404, { msg: 'no mock' });
  });
  await page.route('**/api/auth/**', async (route) => {
    record(route);
    const action = new URL(route.request().url()).pathname.split('/').pop();
    const body = (state.calls.at(-1)!.body ?? {}) as Record<string, string>;
    if (body.captchaToken !== 'XXXX.DUMMY.TOKEN.XXXX')
      return json(route, 400, { error_code: 'turnstile_failed' });
    if (action === 'signup') return json(route, 200, { id: 'new-user', email: body.email });
    return json(route, 200, {});
  });
  await page.route('**/rest/v1/profiles**', async (route) => {
    record(route);
    const m = route.request().method();
    if (m === 'PATCH')
      state.profileName = (state.calls.at(-1)!.body as { display_name: string }).display_name;
    return json(route, 200, [
      {
        id: USER.id,
        display_name: state.profileName,
        role: 'user',
        banned: false,
        created_at: '2026-10-01T00:00:00Z',
      },
    ]);
  });
  return state;
}

const signedInStorage = async (page: Page) => {
  await page.addInitScript((u) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'az-session-v68',
      JSON.stringify({
        access_token: 'jwt-access',
        refresh_token: 'jwt-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: u,
      }),
    );
  }, USER);
};

test.describe('登录', () => {
  test('邮箱密码登录 → 跳回 next → 顶栏显示用户菜单 → 退出', async ({ page, errors }) => {
    const m = await mockAuth(page);
    await page.goto('/login/?next=/forum/');
    await page.getByLabel('邮箱').fill('alice@example.com');
    await page.getByLabel('密码', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('[data-form-status]')).toHaveText('邮箱或密码不正确。');
    await page.getByLabel('密码', { exact: true }).fill('Passw0rd!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/forum/');
    await page.waitForLoadState('networkidle');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('az-session-v68')!));
    expect(stored).toMatchObject({
      access_token: 'jwt-access',
      refresh_token: 'jwt-refresh',
      user: { id: USER.id },
    });
    const menuBtn = page.locator('.avatar-btn');
    await expect(menuBtn).toBeVisible();
    await expect(menuBtn).toHaveAccessibleName('账户菜单：Alice');
    await menuBtn.click();
    await expect(page.getByRole('menuitem', { name: '我的主页' })).toBeFocused();
    await expect(page.getByRole('menuitem', { name: '我的主页' })).toHaveAttribute(
      'href',
      /^\/u\/\?id=9b2c1a10-/,
    );
    await expect(page.getByRole('menuitem', { name: '通知' })).toHaveAttribute('href', '/notifications/');
    await expect(page.getByRole('menuitem', { name: '我的收藏' })).toHaveAttribute('href', '/bookmarks/');
    await expect(page.getByRole('menuitem', { name: '账户设置' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#user-menu-pop')).toBeHidden();
    await menuBtn.click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(page.locator('[data-user-menu] [data-signed-out]')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('az-session-v68'))).toBeNull();
    expect(m.calls.some((c) => c.url.includes('/auth/v1/logout'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('邮箱未验证：提示并给出重新发送入口', async ({ page }) => {
    await mockAuth(page, { confirmed: false });
    await page.goto('/login/');
    await page.getByLabel('邮箱').fill('alice@example.com');
    await page.getByLabel('密码', { exact: true }).fill('Passw0rd!');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('[data-form-status]')).toContainText('邮箱还没有验证');
    await expect(page.getByRole('link', { name: '重新发送确认邮件' })).toHaveAttribute(
      'href',
      '/register/?mode=resend&email=alice%40example.com',
    );
  });

  test('表单校验：空邮箱 / 格式错误', async ({ page }) => {
    await mockAuth(page);
    await page.goto('/login/');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('[data-error-for="email"]')).toHaveText('请填写邮箱');
    await expect(page.getByLabel('邮箱')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('邮箱').fill('nope');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('[data-error-for="email"]')).toHaveText('邮箱地址不正确');
  });
});

test.describe('注册', () => {
  test('校验 → Turnstile token 随请求发给站内端点 → 提示查收确认邮件', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto('/register/');
    await expect(page.locator('.fake-turnstile')).toHaveCount(1); // 隐藏的「重新发送」表单不渲染验证框
    await expect(page.locator('.fake-turnstile')).toBeVisible();
    await page.getByLabel('昵称').fill('小A');
    await page.locator('#reg-email').fill('new@example.com');
    await page.getByLabel('密码', { exact: true }).fill('abcdefgh');
    await page.getByLabel('确认密码').fill('abcdefgh');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.locator('[data-error-for="password"]')).toHaveText('密码需要同时包含字母和数字');
    await expect(page.locator('[data-error-for="agree"]')).toHaveText('请先同意使用条款与隐私说明');
    await page.getByLabel('密码', { exact: true }).fill('abcd1234');
    await page.getByLabel('确认密码').fill('abcd1234');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page.getByRole('heading', { name: '请查收确认邮件' })).toBeVisible();
    await expect(page.locator('[data-done-email]')).toHaveText('new@example.com');
    const call = m.calls.find((c) => c.url.endsWith('/api/auth/signup'))!;
    expect(call.body).toMatchObject({
      email: 'new@example.com',
      password: 'abcd1234',
      data: { name: '小A' },
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
      redirectTo: expect.stringMatching(/\/auth\/callback\/\?next=%2Fsettings%2F%3Fwelcome%3D1$/),
    });
  });

  test('重新发送确认邮件（?mode=resend 预填邮箱）', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto('/register/?mode=resend&email=alice%40example.com');
    await expect(page.getByRole('heading', { name: '重新发送确认邮件' })).toBeVisible();
    await expect(page.locator('[data-resend-panel] input[name="email"]')).toHaveValue('alice@example.com');
    await expect(page.locator('[data-resend-panel] .fake-turnstile')).toBeVisible();
    await page.getByRole('button', { name: '重新发送' }).click();
    await expect(page.locator('[data-resend-panel] [data-form-status]')).toContainText('确认邮件已重新发送');
    expect(m.calls.find((c) => c.url.endsWith('/api/auth/resend'))?.body).toMatchObject({
      type: 'signup',
      email: 'alice@example.com',
    });
  });
});

test.describe('找回密码', () => {
  test('发送重置邮件（不暴露邮箱是否存在）', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto('/reset-password/');
    await page.getByLabel('邮箱').fill('alice@example.com');
    await expect(page.locator('.fake-turnstile')).toBeVisible();
    await page.getByRole('button', { name: '发送重置邮件' }).click();
    await expect(page.locator('[data-reset-request] [data-form-status]')).toContainText('如果这个邮箱已注册');
    expect(m.calls.find((c) => c.url.endsWith('/api/auth/recover'))?.body).toMatchObject({
      email: 'alice@example.com',
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
    });
  });

  test('邮件链接（#type=recovery）→ 设置新密码 → 账户设置', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto(
      '/auth/callback/#access_token=jwt-access&refresh_token=jwt-refresh&expires_in=3600&type=recovery',
    );
    await page.waitForURL('**/reset-password/?mode=update');
    await expect(page.getByRole('heading', { name: '设置新密码' })).toBeVisible();
    await expect(page.locator('[data-reset-email]')).toHaveText('alice@example.com');
    await page.getByLabel('新密码', { exact: true }).fill('newpass99');
    await page.getByLabel('确认新密码').fill('newpass99');
    await page.getByRole('button', { name: '保存新密码' }).click();
    await page.waitForURL((u) => u.pathname === '/settings/');
    expect(m.calls.find((c) => c.method === 'PUT')?.body).toEqual({ password: 'newpass99' });
  });

  test('没有会话直接打开 ?mode=update → 提示链接失效', async ({ page }) => {
    await page.goto('/reset-password/?mode=update');
    await expect(page.locator('[data-reset-expired]')).toBeVisible();
  });
});

test.describe('邮件验证与第三方登录回调', () => {
  test('注册确认链接 → 欢迎提示，地址栏不残留 token', async ({ page }) => {
    await mockAuth(page);
    await page.goto(
      '/auth/callback/?next=%2Fsettings%2F%3Fwelcome%3D1#access_token=jwt-access&refresh_token=jwt-refresh&expires_in=3600&type=signup',
    );
    await page.waitForURL('**/settings/?welcome=1');
    await expect(page.locator('[data-welcome]')).toBeVisible();
    await expect(page.locator('#set-name')).toHaveValue('Alice');
    expect(page.url()).not.toContain('access_token');
  });

  test('过期链接 → 中文错误 + 操作按钮', async ({ page }) => {
    await page.goto(
      '/auth/callback/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    await expect(page.getByRole('heading', { name: '链接无法使用' })).toBeVisible();
    await expect(page.locator('[data-cb-error]')).toHaveText('链接已失效或已被使用，请重新发送。');
    await expect(page.getByRole('link', { name: '重新发送确认邮件' })).toBeVisible();
  });

  test('GitHub 登录：PKCE 跳转 → 回调换取会话 → 跳回 next', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto('/login/?next=/articles/');
    await page.getByRole('button', { name: '使用 GitHub 登录' }).click();
    await page.waitForURL((u) => u.pathname === '/articles/');
    const auth = m.calls.find((c) => c.url.includes('/auth/v1/authorize'))!;
    const q = new URL(auth.url).searchParams;
    expect(q.get('provider')).toBe('github');
    expect(q.get('code_challenge_method')).toBe('s256');
    expect(q.get('redirect_to')).toMatch(/\/auth\/callback\/\?next=%2Farticles%2F$/);
    const pkce = m.calls.find((c) => c.url.includes('grant_type=pkce'))!;
    expect(pkce.body).toMatchObject({
      auth_code: 'oauth-code-1',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43,}$/),
    });
    await expect(page.locator('.avatar-btn')).toBeVisible();
  });
});

test.describe('账户设置', () => {
  test('未登录：显示登录入口', async ({ page }) => {
    await page.goto('/settings/');
    await expect(page.getByRole('heading', { name: '尚未登录' })).toBeVisible();
    await expect(page.locator('[data-settings-signed-in]')).toBeHidden();
  });

  test('已登录（V72 留下的会话也认）：读取资料、改昵称、顶栏同步、退出', async ({ page }) => {
    const m = await mockAuth(page);
    await signedInStorage(page);
    await page.goto('/settings/');
    await expect(page.locator('#set-name')).toHaveValue('Alice');
    await expect(page.locator('[data-acc-email]')).toHaveText('alice@example.com');
    await expect(page.locator('[data-acc-provider]')).toHaveText('邮箱密码');
    await expect(page.locator('[data-acc-role]')).toHaveText('用户');
    await page.locator('#set-name').fill('');
    await page.getByRole('button', { name: '保存昵称' }).click();
    await expect(page.locator('[data-error-for="displayName"]')).toHaveText('昵称不能为空');
    await page.locator('#set-name').fill('Alice Z');
    await page.getByRole('button', { name: '保存昵称' }).click();
    await expect(page.locator('[data-auth-form="settings-name"] [data-form-status]')).toHaveText(
      '昵称已保存。',
    );
    await expect(page.locator('.avatar-btn')).toHaveAccessibleName('账户菜单：Alice Z');
    const patch = m.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ display_name: 'Alice Z' });
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.waitForURL((u) => u.pathname === '/');
    expect(await page.evaluate(() => localStorage.getItem('az-session-v68'))).toBeNull();
  });
});

/**
 * I01 / T074（安全）：回调重放与错误 redirect——**本地回归层**。
 * GoTrue 在这里是假实现（与本文件其余用例相同），只验证站点前端自己的判断：
 * 外域 / 伪装成站内路径的 next 不跳外域、PKCE 授权码不能在本浏览器重放、没有发起过的登录流程被拒、出错时地址栏不残留 token。
 * 真实 Supabase Auth / GitHub OAuth / 收件箱上的 T046 / T074 验收需要隔离测试项目，见 docs/audits/evidence/batch1/i01/README.md（阻塞项）。
 */
test.describe('T074 回调重放与错误 redirect（本地回归层，GoTrue 为假实现）', () => {
  const EVIL = [
    '//evil.example/x',
    '/\\evil.example',
    'https://evil.example/',
    // 浏览器解析 URL 时会删掉制表符 / 换行：「/<TAB>/evil.example」实际变成「//evil.example」（协议相对地址 → 外域）
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r\n/evil.example',
    '/\t\\evil.example',
    ' //evil.example',
  ];
  for (const n of EVIL)
    test(`外域 next ${JSON.stringify(n)} → 登录成功后留在本站首页`, async ({ page }) => {
      await mockAuth(page);
      const outside: string[] = [];
      await page.route(/^https?:\/\/evil\.example\//, (r) => {
        outside.push(r.request().url());
        return r.abort();
      });
      await page.goto(
        `/auth/callback/?next=${encodeURIComponent(n)}#access_token=jwt-access&refresh_token=jwt-refresh&expires_in=3600&type=magiclink`,
      );
      await page.waitForURL((u) => u.pathname === '/' && u.hostname === '127.0.0.1');
      expect(outside).toEqual([]);
      expect(page.url()).not.toContain('evil.example');
      expect(page.url()).not.toContain('access_token');
    });

  test('注册确认：外域 next → 回到欢迎页（不是外域）', async ({ page }) => {
    await mockAuth(page);
    await page.goto(
      `/auth/callback/?next=${encodeURIComponent('/\t/evil.example')}#access_token=jwt-access&refresh_token=jwt-refresh&expires_in=3600&type=signup`,
    );
    await page.waitForURL('**/settings/?welcome=1');
    expect(new URL(page.url()).hostname).toBe('127.0.0.1');
  });

  test('PKCE 授权码重放：同一个 ?code 第二次打开被拒，不再请求换取会话', async ({ page }) => {
    const m = await mockAuth(page);
    await page.goto('/login/?next=/articles/');
    await page.getByRole('button', { name: '使用 GitHub 登录' }).click();
    await page.waitForURL((u) => u.pathname === '/articles/');
    const exchanges = () => m.calls.filter((c) => c.url.includes('grant_type=pkce')).length;
    expect(exchanges()).toBe(1);
    await page.evaluate(() => localStorage.removeItem('az-session-v68'));
    await page.goto('/auth/callback/?code=oauth-code-1&next=%2Farticles%2F');
    await expect(page.getByRole('heading', { name: '链接无法使用' })).toBeVisible();
    await expect(page.locator('[data-cb-error]')).toHaveText('登录流程已失效，请在同一个浏览器里重新开始。');
    expect(exchanges()).toBe(1);
    expect(page.url()).not.toContain('code=');
  });

  test('没有在本浏览器发起过的登录（错 state / 缺 code_verifier）：拒绝，不请求换取会话', async ({
    page,
  }) => {
    const m = await mockAuth(page);
    await page.goto('/auth/callback/?code=forged-code&state=forged');
    await expect(page.getByRole('heading', { name: '链接无法使用' })).toBeVisible();
    expect(m.calls.filter((c) => c.url.includes('grant_type=pkce'))).toEqual([]);
    expect(page.url()).not.toContain('forged');
  });

  test('伪造 / 过期的 access_token：服务端拒绝 → 错误页，地址栏与本地都不留 token', async ({ page }) => {
    await mockAuth(page);
    await page.route('**/auth/v1/user', (r) =>
      r.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }),
      }),
    );
    await page.goto('/auth/callback/#access_token=forged&refresh_token=x&expires_in=3600&type=magiclink');
    await expect(page.getByRole('heading', { name: '链接无法使用' })).toBeVisible();
    expect(page.url()).not.toContain('forged');
    expect(await page.evaluate(() => localStorage.getItem('az-session-v68'))).toBeNull();
  });
});
