/**
 * 确认订阅 / 退订页（T7.8）：从 #token=… 取令牌，点按钮后调用数据库 0016 的 RPC（anon 即可；令牌 256 位，无法枚举）。
 * 只依赖 Supabase 配置这个小模块，不加载整个数据层。
 */
import { supabaseConfig } from '@/lib/supabase-config';
import { tokenFrom } from '@/lib/subscribe-form';

const TEXT = {
  zh: {
    missing: '链接不完整：请直接点击邮件里的链接（或把完整地址复制到浏览器）。',
    working: '正在处理…',
    confirmed: '订阅成功！有新内容时会给你发邮件，每封邮件里都有退订链接。',
    expired: '这个确认链接已过期（48 小时）。请回到订阅页重新提交一次。',
    invalidConfirm: '链接无效或已经用过了。如果已经确认过，就不需要再操作。',
    unsubscribed: '已退订，这个邮箱不会再收到 AZ Studio 的邮件。',
    invalidUnsub: '退订链接无效。请使用邮件里的最新链接。',
    failed: '服务暂时不可用，请稍后再试。',
  },
  en: {
    missing:
      'The link is incomplete. Please click the link in the email (or paste the full address into your browser).',
    working: 'Working…',
    confirmed: 'You are subscribed! Every email includes an unsubscribe link.',
    expired: 'This confirmation link has expired (48 hours). Please subscribe again.',
    invalidConfirm:
      'This link is invalid or has already been used. If you already confirmed, nothing else is needed.',
    unsubscribed: 'You have been unsubscribed. This address will not receive AZ Studio emails any more.',
    invalidUnsub: 'This unsubscribe link is invalid. Please use the link from the latest email.',
    failed: 'The service is temporarily unavailable. Please try again later.',
  },
};

function init(box: HTMLElement) {
  const t = TEXT[box.dataset.lang === 'en' ? 'en' : 'zh'];
  const action = box.dataset.action === 'unsubscribe' ? 'unsubscribe' : 'confirm';
  const btn = box.querySelector<HTMLButtonElement>('[data-sub-go]')!;
  const status = box.querySelector<HTMLElement>('[data-sub-status]')!;
  const token = tokenFrom(location.hash, location.search);
  if (!token) {
    status.textContent = t.missing;
    return;
  }
  btn.disabled = false;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = t.working;
    const { url, key } = supabaseConfig();
    try {
      const res = await fetch(
        `${url}/rest/v1/rpc/${action === 'confirm' ? 'subscribe_confirm' : 'subscribe_unsubscribe'}`,
        {
          method: 'POST',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token: token }),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()) as { status?: string };
      status.textContent =
        r.status === 'confirmed'
          ? t.confirmed
          : r.status === 'unsubscribed'
            ? t.unsubscribed
            : r.status === 'expired'
              ? t.expired
              : action === 'confirm'
                ? t.invalidConfirm
                : t.invalidUnsub;
      // 成功后去掉地址栏里的令牌（刷新 / 分享都不会再带上）
      if (r.status === 'confirmed' || r.status === 'unsubscribed')
        history.replaceState(null, '', location.pathname);
      else btn.disabled = false;
    } catch {
      status.textContent = t.failed;
      btn.disabled = false;
    }
  });
}

const box = document.querySelector<HTMLElement>('[data-sub-token]');
if (box) init(box);
