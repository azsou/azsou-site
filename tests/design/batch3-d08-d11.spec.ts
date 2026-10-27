import { expect, test, type Page } from '@playwright/test';
import { FIXED_TIME } from './pages';
import { settle } from './detect';

/**
 * 批次 3 跟进：D08（动效与玻璃效果成本，T013 / T081 的自动化部分）与 D11（卡片元数据与视觉辨识度，T016）。
 * 真机滚动掉帧（T013 低性能 Android / iPhone）不在这里，另行签字。
 */
test.beforeEach(async ({ page }) => {
  await page.route(/supabase\.co|challenges\.cloudflare\.com|googlesyndication|googletagmanager/, (r) =>
    r.abort(),
  );
});
async function open(page: Page, path: string, vp: { width: number; height: number }) {
  await page.setViewportSize(vp);
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.goto(path, { waitUntil: 'networkidle' });
  await settle(page);
}

// ------------------------------------------------------------------ D08 / T013 / T081
const MOTION_PAGES = ['/', '/apps/', '/ai/', '/forum/', '/search/?q=Claude', '/apps/fablemotion/'];
for (const path of MOTION_PAGES) {
  test(`D08 减少动态 ${path}：运行中的动画（含加载 / 骨架 / 弹层态）不含位移、缩放、旋转，加载态仍有可读名称`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, path, { width: 390, height: 844 });
    // 注入常见状态：忙碌按钮、骨架、提示条
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'd08-states';
      host.innerHTML =
        '<button class="btn btn--primary" aria-busy="true" type="button">提交中</button>' +
        '<button class="btn" aria-busy="true" type="button">保存</button>' +
        '<div class="skeleton" style="width:80px;height:12px"></div>';
      document.querySelector('main')!.prepend(host);
    });
    await page.waitForTimeout(200);
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      const moving = /translate|scale|rotate|matrix|skew/;
      for (const a of document.getAnimations()) {
        const eff = a.effect as KeyframeEffect | null;
        if (!eff || a.playState === 'finished') continue;
        for (const k of eff.getKeyframes()) {
          for (const prop of ['transform', 'translate', 'scale', 'rotate'] as const) {
            const v = (k as Record<string, unknown>)[prop];
            if (typeof v === 'string' && v !== 'none' && (prop !== 'transform' || moving.test(v))) {
              const t = eff.target as Element | null;
              out.push(
                `${(a as CSSAnimation).animationName ?? 'anim'} ${prop}=${v} on ${t?.tagName}.${t?.className}${eff.pseudoElement ?? ''}`,
              );
            }
          }
        }
      }
      return [...new Set(out)];
    });
    expect(bad).toEqual([]);
    // 忙碌按钮：文字被藏起来时仍有可访问名称（读屏）+ 视觉上有静态的进度标记（不靠动画才看得出）
    const busy = page.locator('#d08-states .btn').first();
    await expect(busy).toHaveAccessibleName(/提交中/);
    const mark = await busy.evaluate((b) => {
      const s = getComputedStyle(b, '::after');
      return { content: s.content, w: s.width, border: s.borderTopWidth };
    });
    expect(mark.content).not.toBe('none');
    expect(parseFloat(mark.border)).toBeGreaterThan(0);
  });
}

/** 解析 rgb()/rgba()/color(srgb …) → [r,g,b,a]（0–1） */
const PARSE = `(c) => {
  let m = /^rgba?\\(([^)]+)\\)$/.exec(c);
  if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0]/255, p[1]/255, p[2]/255, p[3] ?? 1]; }
  m = /^color\\(srgb ([^)]+)\\)$/.exec(c);
  if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return null;
}`;

for (const theme of ['light', 'dark'] as const) {
  for (const vp of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    test(`D08 无 backdrop-filter 时 ${theme} ${vp.width}：透明材质上的文字对任意底色仍 ≥ 4.5（图标 ≥ 3），且只有顶栏 / 底栏用透明材质`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await open(page, '/', vp);
      const res = await page.evaluate((parseSrc) => {
        const parse = eval(parseSrc) as (c: string) => number[] | null;
        const lum = ([r, g, b]: number[]) => {
          const f = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (a: number[], b: number[]) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        const over = (top: number[], under: number[]) =>
          [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
        const glassy = [...document.querySelectorAll<HTMLElement>('body *')].filter((e) => {
          const s = getComputedStyle(e);
          const bf =
            s.backdropFilter || (s as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
          return bf && bf !== 'none' && e.getBoundingClientRect().height > 0;
        });
        const names = glassy.map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
        // 关掉毛玻璃：只剩半透明底色，下面可能是纯黑或纯白
        const st = document.createElement('style');
        st.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
        document.head.append(st);
        const worst: string[] = [];
        for (const g of glassy) {
          const bg = parse(getComputedStyle(g).backgroundColor);
          if (!bg) continue;
          for (const el of g.querySelectorAll<HTMLElement>('a, button, span, p, kbd, svg')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
            const isIcon = el.tagName.toLowerCase() === 'svg';
            if (!isIcon && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
              continue;
            // 从透明材质层往下到文字本身，逐层叠底色（含 ::before 垫底）；遇到不透明的一层就不受下方内容影响，跳过
            const chain: HTMLElement[] = [];
            for (let p: HTMLElement | null = el; p && p !== g; p = p.parentElement) chain.unshift(p);
            const layers: number[][] = [];
            let solid = false;
            for (const p of chain) {
              const before = getComputedStyle(p, '::before');
              for (const c of [
                getComputedStyle(p).backgroundColor,
                before.content !== 'none' ? before.backgroundColor : '',
              ]) {
                const b = c ? parse(c) : null;
                if (!b || b[3] === 0) continue;
                if (b[3] > 0.95) solid = true;
                layers.push(b);
              }
            }
            if (solid) continue;
            const fgc = parse(getComputedStyle(el).color);
            if (!fgc) continue;
            const under = (u: number[]) => layers.reduce((acc, l) => over(l, acc), over(bg, u));
            const min = Math.min(
              ...[
                [0, 0, 0],
                [1, 1, 1],
              ].map((u) => ratio(over(fgc, under(u)), under(u))),
            );
            const need = isIcon ? 3 : 4.5;
            if (min < need)
              worst.push(`${(el.textContent || el.tagName).trim().slice(0, 12)} ${min.toFixed(2)} < ${need}`);
          }
        }
        return { names, worst };
      }, PARSE);
      // 只允许顶栏与底栏（手机）用透明材质；普通卡片 / 区块不用
      expect(
        res.names.every((n) => /^header\.|\.tabbar/.test(n)),
        res.names.join(', '),
      ).toBe(true);
      expect(res.worst).toEqual([]);
    });
  }
}

// ------------------------------------------------------------------ D11 / T016
const CARD_PAGES = ['/', '/apps/', '/ai/', '/games/'];
for (const path of CARD_PAGES) {
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`D11 ${path} @${vp.width}：同一行同模板卡片的标题与主操作基线一致，DOM 顺序 = 阅读顺序，卡内元数据不重复`, async ({
      page,
    }) => {
      await open(page, path, vp);
      const res = await page.evaluate(() => {
        const issues: string[] = [];
        const lists = [...document.querySelectorAll<HTMLElement>('ul, ol')].filter((l) =>
          [...l.children].some((c) => c.querySelector(':scope > .entry--tile')),
        );
        for (const l of lists) {
          const cards = [...l.children]
            .map((li) => li.querySelector<HTMLElement>(':scope > .entry--tile'))
            .filter((c): c is HTMLElement => !!c && c.getBoundingClientRect().height > 0);
          const rows = new Map<number, HTMLElement[]>();
          for (const c of cards) {
            const top = Math.round(c.getBoundingClientRect().top);
            const key = [...rows.keys()].find((k) => Math.abs(k - top) <= 2) ?? top;
            rows.set(key, [...(rows.get(key) ?? []), c]);
          }
          const name = l.getAttribute('aria-label') || l.className;
          for (const [, row] of rows) {
            if (row.length < 2) continue;
            const ys = (sel: string) =>
              row
                .map((c) => c.querySelector(sel)?.getBoundingClientRect().top)
                .filter((y): y is number => y != null);
            for (const sel of ['.entry__title', '.entry__action']) {
              const v = ys(sel);
              if (v.length > 1 && Math.max(...v) - Math.min(...v) > 1)
                issues.push(`${name} ${sel} 基线差 ${Math.round(Math.max(...v) - Math.min(...v))}px`);
            }
          }
          // 阅读顺序：按（行、左→右）排序后应与 DOM 顺序一致（横滑轨道只看可见部分也成立）
          const vis = cards.map((c) => ({ c, r: c.getBoundingClientRect() }));
          const sorted = [...vis].sort((a, b) =>
            Math.abs(a.r.top - b.r.top) > 2 ? a.r.top - b.r.top : a.r.left - b.r.left,
          );
          const horizontalScroll = getComputedStyle(l).gridAutoFlow.startsWith('column');
          if (!horizontalScroll && sorted.some((s, i) => s.c !== vis[i].c))
            issues.push(`${name} 视觉顺序 ≠ DOM 顺序`);
        }
        // 卡内元数据：类型 / 开发者 / 事实字段不重复
        for (const e of document.querySelectorAll<HTMLElement>('.entry')) {
          const tok = [
            e.querySelector('.entry__type')?.textContent,
            e.querySelector('.entry__by')?.textContent,
            ...[...e.querySelectorAll('.entry__fact')].map((f) => f.textContent),
          ]
            .filter(Boolean)
            .map((t) => t!.replace(/·/g, '').trim().toLowerCase())
            .filter(Boolean);
          const dup = tok.filter((t, i) => tok.indexOf(t) !== i);
          if (dup.length) issues.push(`${e.dataset.entry} 重复：${dup.join(',')}`);
        }
        return issues;
      });
      expect(res).toEqual([]);
    });
  }
}

for (const width of [320, 390, 600, 768]) {
  test(`D11 首页横滑货架 @${width}：有露出下一项的提示，露出量按比例而不是固定 48px`, async ({ page }) => {
    await open(page, '/', { width, height: 844 });
    const res = await page.evaluate(() => {
      const out: { name: string; frac: number; px: number }[] = [];
      for (const t of document.querySelectorAll<HTMLElement>('[data-shelf]')) {
        if (t.scrollWidth <= t.clientWidth + 1) continue;
        const tr = t.getBoundingClientRect();
        const items = [...t.children] as HTMLElement[];
        const cut = items.find((li) => {
          const r = li.getBoundingClientRect();
          return r.left < tr.right - 1 && r.right > tr.right + 1;
        });
        if (!cut) {
          out.push({ name: t.getAttribute('aria-label') ?? '', frac: 0, px: 0 });
          continue;
        }
        const r = cut.getBoundingClientRect();
        out.push({
          name: t.getAttribute('aria-label') ?? '',
          frac: (tr.right - r.left) / r.width,
          px: Math.round(tr.right - r.left),
        });
      }
      return out;
    });
    expect(res.length).toBeGreaterThan(0);
    for (const s of res) {
      expect(s.frac, `${s.name} 露出比例`).toBeGreaterThan(0.08);
      expect(s.frac, `${s.name} 露出比例`).toBeLessThan(0.75);
    }
  });
}
