/**
 * 浏览器内检测（DESIGN-QA Q5 / Q8 / Q12）：页面横向溢出、拉丁单词内断行、导航 / 按钮单字断行、
 * 意外截断（单行省略号 + 多行 clamp）、字号 / 字重档数。
 * 所有函数都在 page.evaluate 里运行，不能引用外部变量。
 */
import type { Page } from '@playwright/test';

export type Measure = {
  overflow: number;
  midWord: { text: string; where: string }[];
  singleChar: { text: string; where: string }[];
  trunc: { text: string; where: string; kind: 'ellipsis' | 'clamp' }[];
  clampTotal: number;
  fontSizes: string[];
  weights: string[];
  tiny: number;
};

export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((i) => !i.complete && i.loading !== 'lazy')
        .map(
          (i) =>
            new Promise((r) => {
              i.addEventListener('load', r, { once: true });
              setTimeout(r, 3000);
            }),
        ),
    );
  });
}

export function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const where = (el: Element) => {
      const parts: string[] = [];
      let e: Element | null = el;
      while (e && parts.length < 3 && e !== document.body) {
        const cls = (e.getAttribute('class') || '').split(/\s+/)[0];
        parts.unshift(e.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
        e = e.parentElement;
      }
      return parts.join('>');
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const overflow = document.documentElement.scrollWidth - window.innerWidth;

    // 拉丁单词内断行：一个连续 [A-Za-z0-9] 串的 Range 跨了两行
    const midWord: Measure['midWord'] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const skip =
      'script,style,noscript,code,pre,kbd,samp,textarea,.url,.ugc,[data-allow-break],[aria-hidden="true"]';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent || '';
      if (!/[A-Za-z0-9]{3,}/.test(t)) continue;
      const host = n.parentElement;
      if (!host || host.closest(skip) || !visible(host)) continue;
      const re = /[A-Za-z0-9]{3,}/g;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0);
        if (rects.length > 1 && rects[rects.length - 1].top - rects[0].top > rects[0].height / 2) {
          midWord.push({ text: m[0], where: where(host) });
        }
      }
    }

    // 单字断行：导航、按钮、chip、tab、表头里每行只有 1–2 个字
    const singleChar: Measure['singleChar'] = [];
    for (const el of document.querySelectorAll(
      'nav a, nav button, button, .btn, .chip, [role="tab"], th, .tabbar a',
    )) {
      if (!visible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 2) continue;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      // 只看文字本身的行框（图标在上、文字在下的 TabBar 不算换行）
      const tops: number[] = [];
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        if (!t.textContent?.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(t);
        for (const x of r.getClientRects()) if (x.width > 0) tops.push(x.top);
      }
      tops.sort((a, b) => a - b);
      const lines = tops.filter((t, i) => i === 0 || t - tops[i - 1] > lh / 2).length;
      if (lines > 1 && text.length / lines <= 2.5)
        singleChar.push({ text: text.slice(0, 20), where: where(el) });
    }

    // 截断
    const trunc: Measure['trunc'] = [];
    let clampTotal = 0;
    const all = Array.from(document.querySelectorAll('body *')).filter(visible);
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (!el.textContent?.trim() || el.children.length > 3) continue;
      // 有意的一行截断（后台数据表：标题 / 摘要一行 + title 提示全文，DESIGN-SYSTEM §14）
      if (el.closest('[data-truncate-ok]')) continue;
      const clamped = cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '';
      if (clamped) clampTotal++;
      const ell = cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
      const clamp = clamped && el.scrollHeight > el.clientHeight + 2;
      if (ell || clamp)
        trunc.push({
          text: el.textContent.trim().slice(0, 40),
          where: where(el),
          kind: ell ? 'ellipsis' : 'clamp',
        });
    }

    // 字号 / 字重（只统计有可见文字的元素）
    const sizes = new Set<string>();
    const weights = new Set<string>();
    let tiny = 0;
    for (const el of all) {
      if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())) continue;
      const cs = getComputedStyle(el);
      sizes.add(cs.fontSize);
      weights.add(cs.fontWeight);
      if (parseFloat(cs.fontSize) < 12) tiny++;
    }
    return {
      overflow,
      midWord,
      singleChar,
      trunc,
      clampTotal,
      fontSizes: [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
      weights: [...weights].sort(),
      tiny,
    };
  });
}
