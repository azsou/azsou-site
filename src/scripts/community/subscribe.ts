/**
 * 邮件订阅表单（T7.8）：前端校验（与 Function / 数据库同一套规则）→ Turnstile → /api/subscribe。
 * Turnstile 脚本在第一次与表单交互时才加载，不影响首屏。
 */
import { checkSubscribe } from '@/lib/subscribe-form';
import { mountTurnstile, type Captcha } from '../turnstile';

const form = document.querySelector<HTMLFormElement>('[data-sub-form]');
if (form) init(form);

function init(form: HTMLFormElement) {
  const en = form.dataset.lang === 'en';
  const status = form.querySelector<HTMLElement>('[data-form-status]')!;
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let captcha: Captcha | null = null;
  const ensureCaptcha = () => (captcha ??= mountTurnstile(form, () => fieldError('turnstile', null)));
  form.addEventListener('focusin', ensureCaptcha, { once: true });
  form.addEventListener('input', ensureCaptcha, { once: true });

  function fieldError(name: string, msg: string | null) {
    const el = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
    if (el) el.textContent = msg ?? '';
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLElement) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    ensureCaptcha();
    fieldError('email', null);
    fieldError('turnstile', null);
    status.textContent = '';
    const c = checkSubscribe(Object.fromEntries(new FormData(form).entries()));
    if (!c.ok) {
      fieldError(c.field, c.msg);
      (form.elements.namedItem(c.field) as HTMLElement | null)?.focus();
      return;
    }
    const token = captcha!.token();
    if (!token) {
      fieldError(
        'turnstile',
        en ? 'Please wait for the verification to finish.' : '请等待人机验证完成后再提交。',
      );
      return;
    }
    btn.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = en ? 'Sending…' : '正在提交…';
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...c.value, captchaToken: token }),
      });
      let j: { msg?: string; field?: string } = {};
      try {
        j = await res.json();
      } catch {
        /* 没有部署 Function 时是 404 页面 */
      }
      const fallback = en ? 'Something went wrong, please try again later.' : '提交失败，请稍后再试。';
      if (res.ok) {
        form.reset();
        status.textContent = j.msg || (en ? 'Check your inbox to confirm.' : '请查收确认邮件。');
      } else if (j.field && j.msg) {
        fieldError(j.field, j.msg);
        status.textContent = '';
      } else status.textContent = j.msg || fallback;
    } catch {
      status.textContent = en ? 'Network error, please try again.' : '网络错误，请重试。';
    } finally {
      captcha?.reset();
      btn.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}
