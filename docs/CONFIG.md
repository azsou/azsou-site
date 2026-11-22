# 第三方服务配置

Supabase 项目：`abryflgoljltyakthtql`（区域 `ap-southeast-1`，Postgres 17）。下面「现状」是 2026-10-24 通过 Management API 只读查询的结果。

## 1. Supabase Auth：URL

Dashboard → Authentication → URL Configuration

| 项            | 设置                                                                                                                     | 现状                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site URL      | `https://azsou.com`                                                                                                      | ✅ 已是                                                                                                                                                                                                    |
| Redirect URLs | `https://azsou.com/**`、`https://*-azsou.vercel.app/**`（只放行本项目的预览域名）、本地开发加 `http://localhost:4321/**` | `https://azsou.com/**,https://*.vercel.app/**` —— 建议把 `*.vercel.app` 收窄到本项目的预览前缀（Vercel 预览域名形如 `azsou-site-git-<分支>-<团队>.vercel.app`，可写 `https://azsou-site-*.vercel.app/**`） |

站内用到的回调地址：`/auth/callback/`（邮箱确认、魔法链接、找回密码、第三方登录都回到这里，再跳到 `next`）。

## 2. Supabase Auth：邮箱与安全

Authentication → Providers → Email / Authentication → Settings

| 项                          | 建议                                            | 现状                               | 说明                                                                                                   |
| --------------------------- | ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Enable Email provider       | On                                              | On                                 |                                                                                                        |
| Confirm email               | **On**                                          | Off（`mailer_autoconfirm = true`） | 开启后新用户必须点确认邮件才能登录；前端已有「重新发送确认邮件」流程。先配好 SMTP 再开                 |
| Minimum password length     | **8**                                           | 6                                  | 与注册页的前端校验一致                                                                                 |
| Secure email change         | On                                              | —                                  | 改邮箱需新旧邮箱都确认                                                                                 |
| Email OTP expiration        | 3600 秒                                         | 3600                               |                                                                                                        |
| Rate limit: emails/hour     | 配好 SMTP 后调到 30–60                          | 2                                  | 默认（无自定义 SMTP）每小时只能发 2 封，正式上线必须配 SMTP                                            |
| CAPTCHA protection          | Off                                             | Off                                | 人机验证在本站 `/api/auth/*`（Turnstile 服务端校验）+ 0007 注册钩子完成，不用 Supabase 自带的 hCaptcha |
| Hooks → Before User Created | 切换时启用 `public.az_hook_before_user_created` | 未启用                             | 见 MIGRATION.md 第 6 步                                                                                |

## 3. Cloudflare Turnstile

1. Cloudflare Dashboard → Turnstile → Add widget：
   - Widget name：`azsou.com`
   - Hostnames：`azsou.com`、`www.azsou.com`；需要在 Vercel 预览上测试真实验证时再加预览域名（或在预览环境设 `TURNSTILE_ALLOW_TEST_KEYS=1` 用测试密钥）
   - Widget Mode：**Managed**
   - Pre-clearance：No
2. 把 **Site Key** 填到 Vercel 环境变量 `TURNSTILE_SITE_KEY`（Production + Preview），**Secret Key** 填到 `TURNSTILE_SECRET_KEY`。Redeploy。
3. CSP 已放行 `https://challenges.cloudflare.com`（`script-src`、`frame-src`、`connect-src`），无需改动。
4. 验证：打开 `/register/`，人机验证框正常显示；Vercel → Logs 里 `/api/auth/signup` 没有 `turnstile` 错误。

未配置时站点使用 Cloudflare 的测试 key（总是通过）；部署环境（`VERCEL_ENV=production/preview`）缺少私钥时 `/api/auth/*` 会拒绝服务，避免带着测试密钥上线。

## 4. 第三方登录

站内「用 GitHub 登录 / 用 Google 登录」按钮已就绪，Supabase 里启用提供方即可（现状：两者都未启用）。

### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
   - Application name：`AZ Studio`
   - Homepage URL：`https://azsou.com`
   - Authorization callback URL：`https://abryflgoljltyakthtql.supabase.co/auth/v1/callback`
2. 生成 Client secret。
3. Supabase → Authentication → Providers → GitHub → Enable，填 Client ID / Client Secret → Save。

### Google

1. Google Cloud Console → APIs & Services → OAuth consent screen：User type External，App name `AZ Studio`，
   Authorized domains 加 `azsou.com` 与 `supabase.co`，Scopes 只要 `email`、`profile`、`openid`；发布到 Production。
2. Credentials → Create credentials → OAuth client ID → Web application
   - Authorized JavaScript origins：`https://azsou.com`
   - Authorized redirect URIs：`https://abryflgoljltyakthtql.supabase.co/auth/v1/callback`
3. Supabase → Authentication → Providers → Google → Enable，填 Client ID / Client Secret → Save。

第三方首次登录会自动建 `profiles`（昵称取 GitHub 用户名 / Google 姓名）；站点设置里「关闭注册」且启用了钩子时，第三方首次登录也会被拒绝。

## 5. SMTP（发信）

Authentication → Emails → SMTP Settings → Enable Custom SMTP（任选一家：阿里云邮件推送、腾讯云 SES、Resend、Postmark、Amazon SES…）

| 项                              | 值                                                                 |
| ------------------------------- | ------------------------------------------------------------------ |
| Sender email                    | `no-reply@azsou.com`（需要在服务商处验证域名：SPF / DKIM / DMARC） |
| Sender name                     | `AZ Studio`                                                        |
| Host / Port                     | 服务商提供（587 STARTTLS 或 465 SSL）                              |
| Username / Password             | 服务商提供的 SMTP 凭据                                             |
| Minimum interval between emails | 60 秒（默认）                                                      |

DNS 建议：`SPF`：`v=spf1 include:<服务商> ~all`；`DKIM`：按服务商给的 CNAME/TXT；`DMARC`：`_dmarc.azsou.com TXT "v=DMARC1; p=quarantine; rua=mailto:<站长邮箱>"`。

## 6. 中文邮件模板

Authentication → Emails → Templates。每个模板复制「主题」和「正文（HTML）」。`{{ .ConfirmationURL }}` 等是 Supabase 的变量，保持原样。

### 6.1 Confirm signup（注册确认）

主题：

```
确认你的 AZ Studio 账号
```

正文：

```html
<div
  style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f;line-height:1.6"
>
  <h2 style="margin:0 0 16px;font-size:20px">欢迎加入 AZ Studio</h2>
  <p>
    你好！感谢注册 <a href="{{ .SiteURL }}" style="color:#0066cc">azsou.com</a>。请点击下面的按钮确认邮箱
    <strong>{{ .Email }}</strong>，完成注册：
  </p>
  <p style="margin:24px 0">
    <a
      href="{{ .ConfirmationURL }}"
      style="display:inline-block;padding:12px 24px;background:#0071e3;color:#fff;border-radius:10px;text-decoration:none;font-weight:600"
      >确认邮箱</a
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    按钮无法点击时，复制下面的链接到浏览器打开：<br /><span style="word-break:break-all"
      >{{ .ConfirmationURL }}</span
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    链接 1 小时内有效。如果不是你本人注册，请忽略这封邮件，账号不会被创建。
  </p>
  <hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0" />
  <p style="font-size:12px;color:#86868b">AZ Studio · azsou.com（此邮件由系统自动发送，请勿直接回复）</p>
</div>
```

### 6.2 Reset password（重置密码）

主题：

```
重置你的 AZ Studio 密码
```

正文：

```html
<div
  style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f;line-height:1.6"
>
  <h2 style="margin:0 0 16px;font-size:20px">重置密码</h2>
  <p>我们收到了为账号 <strong>{{ .Email }}</strong> 重置密码的请求。点击下面的按钮设置新密码：</p>
  <p style="margin:24px 0">
    <a
      href="{{ .ConfirmationURL }}"
      style="display:inline-block;padding:12px 24px;background:#0071e3;color:#fff;border-radius:10px;text-decoration:none;font-weight:600"
      >设置新密码</a
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    按钮无法点击时，复制下面的链接到浏览器打开：<br /><span style="word-break:break-all"
      >{{ .ConfirmationURL }}</span
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    链接 1 小时内有效，只能使用一次。如果不是你本人操作，请忽略这封邮件，你的密码不会改变。
  </p>
  <hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0" />
  <p style="font-size:12px;color:#86868b">AZ Studio · azsou.com（此邮件由系统自动发送，请勿直接回复）</p>
</div>
```

### 6.3 Magic link（登录链接）

主题：

```
你的 AZ Studio 登录链接
```

正文：

```html
<div
  style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f;line-height:1.6"
>
  <h2 style="margin:0 0 16px;font-size:20px">一键登录</h2>
  <p>
    点击下面的按钮登录 <a href="{{ .SiteURL }}" style="color:#0066cc">azsou.com</a>（账号
    <strong>{{ .Email }}</strong>）：
  </p>
  <p style="margin:24px 0">
    <a
      href="{{ .ConfirmationURL }}"
      style="display:inline-block;padding:12px 24px;background:#0071e3;color:#fff;border-radius:10px;text-decoration:none;font-weight:600"
      >登录</a
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    按钮无法点击时，复制下面的链接到浏览器打开：<br /><span style="word-break:break-all"
      >{{ .ConfirmationURL }}</span
    >
  </p>
  <p style="font-size:14px;color:#6e6e73">
    链接 1 小时内有效，只能使用一次。如果不是你本人操作，请忽略这封邮件。
  </p>
  <hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0" />
  <p style="font-size:12px;color:#86868b">AZ Studio · azsou.com（此邮件由系统自动发送，请勿直接回复）</p>
</div>
```

（站内目前没有「魔法链接登录」入口；配置好模板以备在 Dashboard 手动发送或以后启用。另外两个可选模板 Change email address / Invite user 可参照上面的样式改写。）

## 7. Supabase Storage（图片）

- 由迁移 `0010_ugc_images.sql` 创建桶 `ugc-images`（Public、2 MB、jpeg / png / webp / gif）与 3 条 RLS 策略，**不需要在 Dashboard 手动建桶**。
- Dashboard → Storage → Settings → Upload file size limit（全局上限）需 ≥ 2 MB（默认 50 MB，满足）。
- 图片公开地址：`https://abryflgoljltyakthtql.supabase.co/storage/v1/object/public/ugc-images/<用户 id>/<文件名>`；
  前端只显示这个桶里、路径符合规则的图片（防止外链追踪）。CSP `img-src` 已放行 `https://*.supabase.co`。
- 浏览器端会把图片缩到最长边 1600 px 并转成 WebP（旧版 Safari 不支持 WebP 编码时用 JPEG），通常每张 100–400 KB。

## 8. 其他

- **Supabase API Keys**：前端只用 publishable key（`sb_publishable_…`），应通过 Vercel 环境变量 `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_KEY` 提供；
  `scripts/supabase-env.mjs` 里的生产默认值只在 Vercel 生产（或本机 / CI）漏配时兜底，Preview / Development 缺配置会构建失败（docs/DEPLOY.md「Supabase 连接配置」）；
  secret key 不在任何代码或 Vercel 变量里。
- **数据库网络限制**（可选）：Project Settings → Database → Network Restrictions。GitHub Actions 备份从 GitHub 托管机器连接，
  开启限制前需要放行 GitHub Actions 的 IP 段，或改用自托管 runner。
- **keepalive**：`.github/workflows/supabase-keepalive.yml` 每 3 天读一行公开数据，防止免费项目暂停；升级 Pro 后可删除。

## 9. Google（AdSense / GA4 / Search Console）与公开联系方式（P8）

全部是**可选**的构建期环境变量（Vercel → Settings → Environment Variables），默认不设 = 关闭；格式不对的值视为未设置。
详细步骤、申请前提与上线检查见 [ADSENSE.md](ADSENSE.md)。

| 变量                                                                                       | 作用                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `PUBLIC_ADSENSE_CLIENT`                                                                    | `ca-pub-` + 16 位数字；开启 `/ads.txt`、账户 meta、长文与文章列表的广告位 |
| `PUBLIC_ADSENSE_SLOT_ARTICLE` / `PUBLIC_ADSENSE_SLOT_SIDEBAR` / `PUBLIC_ADSENSE_SLOT_LIST` | 三个广告单元 ID（没填的位置不出广告）                                     |
| `PUBLIC_GA4_ID`                                                                            | `G-…`；GA4，受 Consent Mode v2 约束                                       |
| `PUBLIC_GSC_VERIFICATION`                                                                  | Search Console「HTML 标记」验证码（首页 meta）                            |
| `PUBLIC_CONTACT_EMAIL`                                                                     | 在联系页 / 隐私政策公开的邮箱                                             |

设置 `PUBLIC_ADSENSE_CLIENT` 或 `PUBLIC_GA4_ID` 时，必须同时运行 `npm run csp:google -- on --ads --ga`（或只 `--ga`）并提交 `vercel.json`，否则构建的 `prebuild` 检查会失败。
