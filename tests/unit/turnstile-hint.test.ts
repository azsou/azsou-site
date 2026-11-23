import { describe, expect, it } from 'vitest';
import { turnstileErrorText } from '@/lib/turnstile-hint';

describe('Turnstile 报错提示', () => {
  it('带上 Cloudflare 的错误码，并提示可以重新验证', () => {
    const t = turnstileErrorText('600010');
    expect(t).toContain('错误码 600010');
    expect(t).toContain('重新验证');
  });

  it('没有错误码时不留下空括号', () => {
    const t = turnstileErrorText(undefined);
    expect(t).not.toContain('错误码');
    expect(t).not.toContain('（）');
    expect(t).toContain('重新验证');
  });

  it('错误码只保留字母数字和 _-，其余（含 HTML）一律丢弃', () => {
    const html = turnstileErrorText('<img src=x onerror=1>');
    expect(html).not.toContain('<');
    expect(html).not.toContain('错误码');
    expect(turnstileErrorText('1234567890123')).not.toContain('错误码');
  });

  it('英文页面给英文提示', () => {
    const t = turnstileErrorText('110200', true);
    expect(t).toContain('code 110200');
    expect(t).toContain('Verify again');
    expect(t).not.toMatch(/[\u4e00-\u9fa5]/);
  });
});
