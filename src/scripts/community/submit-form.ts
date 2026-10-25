/**
 * 留言 / 友链申请表单（T7.3 / T7.4）共用：前端校验（与服务端、数据库同一套规则）→ Turnstile → /api/submit/<kind>。
 * Turnstile 脚本在用户第一次与表单交互（聚焦 / 输入）时才加载，不影响首屏。
 */
import type { Checked, SubmitKind } from '@/lib/community-forms';
import { getGuestbook, SubmitError } from '@/lib/data/guestbook';
import { friendlyError } from '@/lib/community-errors';
import { mountTurnstile, type Captcha } from '../turnstile';

export function initSubmitForm<T extends object>(
  form: HTMLFormElement,
  kind: SubmitKind,
  check: (input: Record<string, unknown>) => Checked<T>,
  done: string,
) {
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
  const values = () => Object.fromEntries(new FormData(form).entries()) as Record<string, unknown>;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    ensureCaptcha();
    for (const el of form.querySelectorAll<HTMLElement>('[data-error-for]'))
      fieldError(el.dataset.errorFor!, null);
    status.textContent = '';
    const c = check(values());
    if (!c.ok) {
      fieldError(c.field, c.msg);
      (form.elements.namedItem(c.field) as HTMLElement | null)?.focus();
      return;
    }
    const token = captcha!.token();
    if (!token) {
      fieldError('turnstile', '请等待人机验证完成后再提交。');
      return;
    }
    btn.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = '正在提交…';
    try {
      await getGuestbook().submit(kind, c.value as never, token);
      form.reset();
      form.dispatchEvent(new Event('input'));
      status.textContent = done;
    } catch (err) {
      if (err instanceof SubmitError && err.field) {
        fieldError(err.field, err.message);
        status.textContent = '';
      } else
        status.textContent =
          err instanceof SubmitError ? err.message : friendlyError(err, '提交失败，请稍后再试。');
    } finally {
      captcha?.reset();
      btn.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}
