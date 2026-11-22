/**
 * 事务邮件模板（T9.15，DESIGN-SYSTEM §20）：中英两套共用一个骨架——
 * preheader（收件箱预览文字，正文里隐藏）、品牌头（文字 Logo，不依赖外链图片）、600px 居中表格布局、
 * bulletproof 按钮（表格单元格背景 + 链接，Outlook 也是实心按钮）、深色模式（color-scheme + 媒体查询）、页脚退订。
 * 只用内联样式 + <style> 里的深色覆盖；所有插值都转义。
 */
export interface EmailParts {
  lang: 'zh' | 'en';
  preheader: string;
  title: string;
  paragraphs: string[];
  cta: { label: string; url: string };
  footnote: string;
  unsubscribe: { label: string; url: string };
}

export const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ACCENT = '#1d7a4e';
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";

export function renderEmail(p: EmailParts): string {
  const e = escHtml;
  const paras = p.paragraphs
    .map(
      (t) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#1d1d1f" class="em-text">${e(t)}</p>`,
    )
    .join('');
  return `<!doctype html>
<html lang="${p.lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(p.title)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .em-body, .em-bg { background:#000000 !important; }
    .em-card { background:#1c1c1e !important; }
    .em-text, .em-title { color:#f5f5f7 !important; }
    .em-muted, .em-muted a { color:#a1a1a6 !important; }
  }
  @media (max-width: 620px) { .em-card { padding:24px !important; } }
</style>
</head>
<body class="em-body" style="margin:0;padding:0;background:#f5f5f7;font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${e(p.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-bg" style="background:#f5f5f7">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="padding:0 8px 16px;font-size:15px;font-weight:700;color:#1d1d1f" class="em-title">
<span style="display:inline-block;width:28px;height:28px;line-height:28px;border-radius:7px;background:${ACCENT};color:#ffffff;text-align:center;font-size:12px;margin-right:8px">AZ</span>AZ Studio
</td></tr>
<tr><td class="em-card" style="background:#ffffff;border-radius:16px;padding:32px">
<h1 class="em-title" style="margin:0 0 16px;font-size:22px;line-height:1.4;color:#1d1d1f">${e(p.title)}</h1>
${paras}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px">
<tr><td align="center" bgcolor="${ACCENT}" style="border-radius:999px">
<a href="${e(p.cta.url)}" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px">${e(p.cta.label)}</a>
</td></tr></table>
<p class="em-muted" style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#6e6e73">${e(p.lang === 'en' ? 'Button not working? Copy this link:' : '按钮无法点击？复制此链接：')}<br><a href="${e(p.cta.url)}" style="color:#6e6e73;word-break:break-all">${e(p.cta.url)}</a></p>
<p class="em-muted" style="margin:0;font-size:13px;line-height:1.6;color:#6e6e73">${e(p.footnote)}</p>
</td></tr>
<tr><td class="em-muted" style="padding:16px 8px 0;font-size:12px;line-height:1.6;color:#6e6e73">
${e(p.lang === 'en' ? 'You received this because this address was entered on azsou.com.' : '你收到这封邮件，是因为有人在 azsou.com 填写了这个邮箱。')}<br>azsou.com · <a href="${e(p.unsubscribe.url)}" style="color:#6e6e73;text-decoration:underline">${e(p.unsubscribe.label)}</a>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}
