/**
 * Turnstile 报错时给访客看的提示：纯文本函数（可单测）+ 一个带「重新验证」按钮的 DOM 小工具。
 * 错误码来自 Cloudflare 的 error-callback，只保留字母数字和 _-，最长 12 位，避免把任意文本写进页面。
 */
export function turnstileErrorText(code: unknown, en = false): string {
  const c = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
  const safe = /^[\w-]{1,12}$/.test(c) ? c : '';
  if (en)
    return safe
      ? `Verification failed to load (code ${safe}). Use Verify again, or check your network, proxy and system clock, then reload.`
      : 'Verification failed to load. Use Verify again, or check your network, proxy and system clock, then reload.';
  return safe
    ? `人机验证加载失败（错误码 ${safe}）。请点「重新验证」，或检查网络、代理和系统时间后刷新页面。`
    : '人机验证加载失败。请点「重新验证」，或检查网络、代理和系统时间后刷新页面。';
}

/** 在提示位显示报错文字和「重新验证」按钮；点按钮会清掉提示并调用 retry（重置验证框） */
export function captchaError(hint: HTMLElement | null, code: unknown, en: boolean, retry: () => void) {
  if (!hint) return;
  hint.textContent = turnstileErrorText(code, en);
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = en ? 'Verify again' : '重新验证';
  b.addEventListener('click', () => {
    hint.textContent = '';
    retry();
  });
  hint.append(' ', b);
}
