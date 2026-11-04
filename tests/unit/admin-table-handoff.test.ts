// @vitest-environment jsdom
/**
 * [jsdom 机制测试] 数据表断点交接的焦点归属（R12，R12-B 修订：取消优先 / rAF 按最新归属判断 / 弹出面板阻挡）。
 * 只验证 table2.ts 的事件处理机制：jsdom 不做布局、不派发真实的 resize / matchMedia change，也不会因为
 * 控件被隐藏而自动失焦。这里用桩模拟：
 *  - matchMedia：可手动改 matches、手动派发 change（或不派发，模拟 WebKit 快速来回时没有 change）；
 *  - checkVisibility：[hidden] / [data-test-hidden] 视为不渲染（display:none）；其余一律可见——包括窄屏下只被
 *    clip-path 裁切的 thead（真实浏览器里 checkVisibility() 对裁切也返回 true，用来区分 clipped 与 hidden）；
 *  - 浏览器「隐藏控件失焦到 BODY」用 el.blur() 模拟（relatedTarget=null）；
 *  - requestAnimationFrame：手动队列，flush() 才执行；
 *  - document.hasFocus()：jsdom 在焦点落到 BODY 后返回 false，真实窗口有焦点时为 true，这里桩成 true。
 * 真实浏览器中的时序（Chromium 先失焦后 MQ、WebKit 来回无 MQ change）只能由 E2E 验证，本文件不能替代。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhanceTable } from '@/scripts/admin/table2';

const TABLE = (
  key: string,
) => `<div class="table-wrap"><table class="data-table" data-cards data-server-sort data-table2="${key}">
  <thead><tr><th class="col-check"><span>选择</span></th><th data-sort-key="title">内容</th><th>备注</th><th data-sort-key="created_at">注册时间</th></tr></thead>
  <tbody><tr data-row><td><input type="checkbox"></td><td>甲</td><td><button type="button" class="row-btn">查看</button></td><td>2026</td></tr></tbody>
</table></div>`;

type Mq = { matches: boolean; fire(): void; count(): number };
let mq: Mq;
let rafQ: Map<number, FrameRequestCallback>;
const restores: (() => void)[] = [];

function flush() {
  const cbs = [...rafQ.values()];
  rafQ = new Map();
  cbs.forEach((f) => f(0));
}

beforeEach(() => {
  const ls: (() => void)[] = [];
  mq = {
    matches: true,
    fire: () => ls.forEach((f) => f()),
    count: () => ls.length,
  };
  const fake = {
    ...mq,
    addEventListener: (_t: string, f: () => void) => ls.push(f),
    removeEventListener() {},
  };
  Object.defineProperty(fake, 'matches', { get: () => mq.matches });
  const origMM = window.matchMedia;
  window.matchMedia = (() => fake) as unknown as typeof window.matchMedia;
  restores.push(() => (window.matchMedia = origMM));
  const proto = HTMLElement.prototype as unknown as { checkVisibility?: unknown };
  const origCV = proto.checkVisibility;
  proto.checkVisibility = function (this: HTMLElement) {
    return !this.closest('[hidden], [data-test-hidden]');
  };
  restores.push(() => {
    if (origCV === undefined) delete proto.checkVisibility;
    else proto.checkVisibility = origCV;
  });
  rafQ = new Map();
  let id = 0;
  const origRaf = window.requestAnimationFrame;
  const origCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQ.set(++id, cb);
    return id;
  };
  window.cancelAnimationFrame = (h: number) => void rafQ.delete(h);
  restores.push(() => {
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
  });
  const hf = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  restores.push(() => hf.mockRestore());
});

afterEach(() => {
  // 先移除表格，再触发一次 resize 让残留监听自行撤销
  document.body.innerHTML = '';
  window.dispatchEvent(new Event('resize'));
  while (restores.length) restores.pop()!();
  vi.restoreAllMocks();
});

/** 建一张表（可指定 key / 追加到 body），返回常用句柄。初始为窄屏（mq.matches=true）。 */
function mount(key = 't-h', append = false) {
  if (!append) mq.matches = true;
  if (append) document.body.insertAdjacentHTML('beforeend', TABLE(key));
  else document.body.innerHTML = TABLE(key);
  const table = document.querySelector<HTMLTableElement>(`table[data-table2="${key}"]`)!;
  const events: unknown[] = [];
  table.addEventListener('table2:sort', (e) => events.push((e as CustomEvent).detail));
  enhanceTable(table);
  const tools = table.closest('.table-wrap')!.previousElementSibling as HTMLElement;
  const sel = tools.querySelector<HTMLSelectElement>('.table-tools__sort select')!;
  const th = (n: number) => table.querySelector<HTMLButtonElement>(`thead [data-sort-col="${n}"]`)!;
  const choose = (v: string) => {
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
  };
  /** 模拟布局：宽屏隐藏工具条下拉（display:none），窄屏显示；窄屏表头只裁切（桩里仍可见） */
  const layout = (narrow: boolean, { fire = true, hideCol4 = false } = {}) => {
    mq.matches = narrow;
    tools.querySelector('.table-tools__sort')!.toggleAttribute('data-test-hidden', !narrow);
    table.querySelector('thead th:nth-child(4)')!.toggleAttribute('data-test-hidden', hideCol4);
    if (fire) mq.fire();
  };
  return { table, tools, sel, th, choose, layout, events };
}

const ae = () => document.activeElement;
const body = () => document.body;

describe('[jsdom 机制测试] 断点交接焦点归属（R12）', () => {
  it('缺陷正对照 A：MQ change 处理时隐藏的下拉已先失焦到 BODY → 仍交给可见表头，不改排序 / 不派发 / 不改隐藏偏好', () => {
    const t = mount('t-pa');
    t.choose('4:ascending');
    const hideBefore = t.table.dataset.hide ?? '';
    t.sel.focus();
    // 800 → 1000：下拉被隐藏，第 4 列（data-priority=3）在 <1200 仍隐藏；浏览器先把焦点修正为 BODY，再派发 MQ change
    t.layout(false, { fire: false, hideCol4: true });
    t.sel.blur();
    expect(ae()).toBe(body());
    mq.fire();
    expect(ae()).toBe(t.th(2));
    flush(); // 过期的 rAF 不覆盖
    expect(ae()).toBe(t.th(2));
    expect(t.sel.value).toBe('4:ascending');
    expect(t.table.querySelector('thead th:nth-child(4)')!.getAttribute('aria-sort')).toBe('ascending');
    expect(t.events).toHaveLength(1);
    expect(t.table.dataset.hide ?? '').toBe(hideBefore);
  });

  it('缺陷正对照 B：快速 1000→800→1000 没有任何 MQ change → resize 合并的 rAF 仍交给可见表头', () => {
    const t = mount('t-pb');
    t.choose('4:ascending');
    t.sel.focus();
    t.layout(false, { hideCol4: true }); // 800 → 1000（有 MQ change）
    expect(ae()).toBe(t.th(2));
    // 1000 → 800：没有 resize、没有 MQ change（matches 读数仍是宽屏）；测试把焦点放回下拉
    t.tools.querySelector('.table-tools__sort')!.removeAttribute('data-test-hidden');
    t.sel.focus();
    // 800 → 1000：只有 resize，没有 MQ change；浏览器把隐藏的下拉失焦到 BODY
    t.tools.querySelector('.table-tools__sort')!.setAttribute('data-test-hidden', '');
    t.sel.blur();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(t.th(2));
    expect(t.events).toHaveLength(1);
    expect(rafQ.size).toBe(0); // 不循环
  });

  it('resize 时焦点仍停在已隐藏的下拉上（WebKit 形态，没有 blur、没有 MQ change）→ 交给表头', () => {
    const t = mount('t-c1');
    t.choose('2:descending');
    t.sel.focus();
    t.layout(false, { fire: false });
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(t.th(2));
  });

  it('clipped：窄屏表头 checkVisibility() 仍为 true，但按断点 + 角色不合格 → 交给下拉（无 MQ change 也行）', () => {
    const t = mount('t-clip');
    t.layout(false);
    t.th(2).focus();
    expect((t.th(2) as HTMLElement).checkVisibility()).toBe(true);
    t.layout(true, { fire: false }); // 窄屏：thead 只被裁切
    expect((t.th(2) as HTMLElement).checkVisibility()).toBe(true);
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(t.sel);
  });

  it('hidden：目标列 display:none 时跳过 → 其它可见表头；全部表头不渲染 → 工具条按钮', () => {
    const t = mount('t-hid');
    t.choose('4:ascending');
    t.sel.focus();
    t.layout(false, { hideCol4: true });
    expect(ae()).toBe(t.th(2));
    t.layout(true);
    expect(ae()).toBe(t.sel);
    t.table.tHead!.setAttribute('data-test-hidden', '');
    t.layout(false);
    expect((ae() as HTMLElement).closest('.table-tools')).toBe(t.tools);
    expect(ae()).not.toBe(t.sel);
    expect(t.events).toHaveLength(1);
  });

  it('visible：记录的控件在当前断点仍有效时不动，也不调用 focus()', () => {
    const t = mount('t-vis');
    t.layout(false);
    t.th(4).focus();
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    window.dispatchEvent(new Event('resize'));
    flush();
    mq.fire();
    expect(ae()).toBe(t.th(4));
    expect(spy).not.toHaveBeenCalled();
  });

  it('期间焦点已到目标：MQ change / 过期 rAF 都不再调用 focus()', () => {
    const t = mount('t-noref');
    t.sel.focus();
    t.layout(false, { fire: false });
    t.sel.blur();
    t.th(2).focus(); // 期间焦点已到目标（新的归属记录）
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    mq.fire();
    flush();
    expect(ae()).toBe(t.th(2));
    expect(spy).not.toHaveBeenCalled();
  });

  it('disconnected：记录的下拉被移除 → 放弃记录，不当作交接', () => {
    const t = mount('t-dis');
    t.sel.focus();
    t.sel.remove(); // jsdom：焦点回到 BODY，无 focusout
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    t.layout(false, { fire: false });
    mq.fire();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(body());
    expect(spy).not.toHaveBeenCalled();
  });

  it('replaced：表格被整体替换 → 旧表撤销监听，不聚焦旧表或新表的任何控件', () => {
    const t = mount('t-rep');
    t.sel.focus();
    const sigs: AbortSignal[] = [];
    // 只观察，不改变：撤销后 signal.aborted 为 true
    const orig = AbortController.prototype.abort;
    const ab = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (
      this: AbortController,
    ) {
      sigs.push(this.signal);
      return orig.call(this);
    });
    document.body.innerHTML = TABLE('t-rep-new').replace('data-cards', ''); // 新表不增强
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    mq.matches = false;
    mq.fire();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(body());
    expect(spy).not.toHaveBeenCalled();
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs.every((s) => s.aborted)).toBe(true);
    ab.mockRestore();
  });

  it('防抢：焦点进入行内按钮 / 页面其它输入框 → 取消记录，断点切换不移动它', () => {
    const t = mount('t-row');
    document.body.insertAdjacentHTML('beforeend', '<input id="other">');
    const row = t.table.querySelector<HTMLButtonElement>('.row-btn')!;
    t.sel.focus();
    row.focus();
    t.layout(false);
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(row);
    t.layout(true);
    t.sel.focus();
    document.querySelector<HTMLInputElement>('#other')!.focus();
    t.layout(false);
    flush();
    expect(ae()).toBe(document.querySelector('#other'));
  });

  it('防抢：已排队的交接被新焦点取消，过期 rAF 不覆盖', () => {
    const t = mount('t-pend');
    document.body.insertAdjacentHTML('beforeend', '<input id="other">');
    t.sel.focus();
    t.layout(false, { fire: false });
    t.sel.blur(); // 排队一个 rAF
    expect(rafQ.size).toBe(1);
    const other = document.querySelector<HTMLInputElement>('#other')!;
    other.focus();
    // R12-B：取消只放弃归属，已排队的 rAF 保留；执行时按最新状态判断（归属为空 → 只同步 tabindex，不动焦点）
    expect(rafQ.size).toBe(1);
    flush();
    expect(ae()).toBe(other);
    mq.fire();
    window.dispatchEvent(new Event('resize'));
    flush();
    expect(ae()).toBe(other);
  });

  it('防抢：焦点进入另一张表 → 本表放弃记录，永不把焦点拉回本表', () => {
    const a = mount('t-a');
    const b = mount('t-b', true);
    a.sel.focus();
    b.sel.focus();
    // 两张表同时切到宽屏；浏览器把 b 的隐藏下拉失焦
    a.tools.querySelector('.table-tools__sort')!.setAttribute('data-test-hidden', '');
    b.layout(false, { fire: false });
    b.sel.blur();
    mq.fire();
    flush();
    expect((ae() as HTMLElement).closest('table')).toBe(b.table);
    expect(a.table.contains(ae()) || a.tools.contains(ae())).toBe(false);
  });

  it('防抢：在非本表控件处 pointerdown（本表空白单元格 / 页面空白）→ 取消记录', () => {
    for (const where of ['cell', 'page'] as const) {
      const t = mount(`t-blank-${where}`);
      t.layout(true);
      t.sel.focus();
      const target = where === 'cell' ? t.table.querySelector('tbody td:nth-child(2)')! : document.body;
      target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      t.sel.blur(); // 点空白：焦点到 BODY
      t.layout(false);
      window.dispatchEvent(new Event('resize'));
      flush();
      expect(ae()).toBe(body());
    }
  });

  it('pointerdown 在本表合格控件上不取消（随后的 focusin 重新记录）', () => {
    const t = mount('t-pd-own');
    t.sel.focus();
    t.sel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    t.layout(false, { fire: false });
    t.sel.blur();
    mq.fire();
    expect(ae()).toBe(t.th(2));
  });

  it('防抢：Tab 离开 → 取消记录（Escape 见下方「保留 activeElement」用例）', () => {
    for (const key of ['Tab']) {
      const t = mount(`t-key-${key}`);
      t.layout(true);
      t.sel.focus();
      t.sel.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      t.sel.blur();
      t.layout(false);
      window.dispatchEvent(new Event('resize'));
      flush();
      expect(ae()).toBe(body());
    }
  });

  it('防抢：窗口失焦 / 页面隐藏 / hasFocus()=false 时不抢；回到前台不自动恢复', () => {
    // 窗口 blur
    let t = mount('t-win');
    t.sel.focus();
    window.dispatchEvent(new FocusEvent('blur'));
    t.sel.blur();
    t.layout(false);
    flush();
    expect(ae()).toBe(body());
    // document.hidden
    t = mount('t-hidden');
    t.sel.focus();
    let hiddenNow = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenNow });
    document.dispatchEvent(new Event('visibilitychange'));
    t.sel.blur();
    t.layout(false);
    flush();
    expect(ae()).toBe(body());
    hiddenNow = false;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('resize'));
    t.layout(false);
    flush();
    expect(ae()).toBe(body());
    delete (document as unknown as { hidden?: boolean }).hidden; // 回到 Document.prototype 上的原始 getter
    // hasFocus() = false（没有 window blur 事件也不抢）；之后恢复为 true 也不自动恢复
    t = mount('t-hasfocus');
    t.sel.focus();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    t.layout(false, { fire: false });
    t.sel.blur();
    mq.fire();
    flush();
    expect(ae()).toBe(body());
    vi.mocked(document.hasFocus).mockReturnValue(true);
    window.dispatchEvent(new Event('resize'));
    flush();
    mq.fire();
    expect(ae()).toBe(body());
  });

  it('防抢：真正打开且可见的模态挡住交接；常驻但隐藏 / inert 的 aria-modal 节点不挡', () => {
    const cases: [string, boolean][] = [
      ['<dialog open id="m">x</dialog>', true],
      ['<div role="dialog" aria-modal="true" id="m">x</div>', true],
      ['<div role="dialog" aria-modal="true" hidden id="m">x</div>', false],
      ['<div inert><div role="dialog" aria-modal="true" id="m">x</div></div>', false],
      ['<dialog id="m">x</dialog>', false],
    ];
    for (const [html, blocks] of cases) {
      const t = mount('t-modal');
      document.body.insertAdjacentHTML('beforeend', html);
      t.sel.focus();
      t.layout(false, { fire: false });
      t.sel.blur();
      mq.fire();
      flush();
      expect([html, ae() === t.th(2)]).toEqual([html, !blocks]);
      if (blocks) expect(ae()).toBe(body());
    }
  });

  it('resize 按需：没有归属记录且断点未变时不排 rAF；需要时多次 resize 合并为一个', () => {
    const t = mount('t-ondemand');
    t.table.querySelector<HTMLButtonElement>('.row-btn')!.focus();
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(rafQ.size).toBe(0);
    t.layout(false, { fire: false }); // 断点变了但没有 MQ change：排一个 rAF 只同步 tabindex，不动焦点
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(rafQ.size).toBe(1); // 同一帧多次 resize 合并成一个 rAF
    flush();
    expect(t.th(2).hasAttribute('tabindex')).toBe(false);
    expect(t.table.querySelector<HTMLElement>('thead .th-resize')!.tabIndex).toBe(0);
    expect(ae()).toBe(t.table.querySelector('.row-btn'));
  });

  it('幂等初始化：已有工具条时重复 enhanceTable 提前返回，不重复注册监听（只证明这条提前返回路径）', () => {
    const d = vi.spyOn(document, 'addEventListener');
    const w = vi.spyOn(window, 'addEventListener');
    const t = mount('t-idem');
    enhanceTable(t.table);
    enhanceTable(t.table);
    const count = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).length;
    expect(
      ['focusin', 'focusout', 'pointerdown', 'keydown', 'visibilitychange'].map((k) => count(d, k)),
    ).toEqual([1, 1, 1, 1, 1]);
    expect(['resize', 'blur'].map((k) => count(w, k))).toEqual([1, 1]);
    expect(mq.count()).toBe(1);
  });
  describe('R12-B A：取消优先——取消后旧控件仍是 activeElement（不调用 blur()），之后的断点切换不得据此交接', () => {
    /** 宽屏后焦点仍停在被隐藏的下拉上（不 blur），MQ change 与 resize + rAF 都不交接、也不调用 focus() */
    const expectNoHandoff = (t: ReturnType<typeof mount>) => {
      const spy = vi.spyOn(HTMLElement.prototype, 'focus');
      t.layout(false); // 有 MQ change
      expect(ae()).toBe(t.sel);
      window.dispatchEvent(new Event('resize'));
      flush();
      expect(ae()).toBe(t.sel);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      // tabindex 仍按断点同步（宽屏：表头排序按钮回到 Tab 顺序）
      expect(t.th(2).hasAttribute('tabindex')).toBe(false);
      t.layout(true); // 回到窄屏：下拉重新可见，仍是 activeElement
      expect(ae()).toBe(t.sel);
    };

    it('Escape：下拉仍是焦点 → 不交接；之后在该下拉上 pointerdown（新的交互）重新建立归属 → 交接', () => {
      const t = mount('t-r-esc');
      t.sel.focus();
      t.sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(ae()).toBe(t.sel);
      expectNoHandoff(t);
      t.sel.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      t.layout(false);
      expect(ae()).toBe(t.th(2));
      expect(t.events).toHaveLength(0);
    });

    it('窗口 blur 后再 focus（回到前台）：下拉仍是焦点 → 不交接；之后在下拉上 keydown 重新建立归属 → 交接', () => {
      const t = mount('t-r-win');
      t.sel.focus();
      window.dispatchEvent(new FocusEvent('blur'));
      window.dispatchEvent(new FocusEvent('focus'));
      expect(ae()).toBe(t.sel);
      expectNoHandoff(t);
      t.sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      t.layout(false, { fire: false }); // 只有 resize，没有 MQ change
      window.dispatchEvent(new Event('resize'));
      flush();
      expect(ae()).toBe(t.th(2));
    });

    it('visibilitychange 隐藏后再可见：下拉仍是焦点 → 不交接；之后新的 focusin 重新建立归属 → 交接', () => {
      const t = mount('t-r-vis');
      t.sel.focus();
      let hiddenNow = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenNow });
      document.dispatchEvent(new Event('visibilitychange'));
      hiddenNow = false;
      document.dispatchEvent(new Event('visibilitychange'));
      try {
        expect(ae()).toBe(t.sel);
        expectNoHandoff(t);
        // 新的 focusin：先到本表工具条按钮，再回到下拉（真实的焦点移动，不是 blur 模拟取消）
        t.tools.querySelector<HTMLButtonElement>('[data-export-csv]')!.focus();
        t.sel.focus();
        t.layout(false);
        expect(ae()).toBe(t.th(2));
      } finally {
        delete (document as unknown as { hidden?: boolean }).hidden;
      }
    });

    it('空白 pointerdown（表内单元格 / 页面）：下拉仍是 activeElement → 不交接；新的 focusin 后交接', () => {
      for (const where of ['cell', 'page'] as const) {
        const t = mount(`t-r-blank-${where}`);
        t.sel.focus();
        const target = where === 'cell' ? t.table.querySelector('tbody td:nth-child(2)')! : document.body;
        target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(ae()).toBe(t.sel);
        expectNoHandoff(t);
        t.tools.querySelector<HTMLButtonElement>('[data-export-csv]')!.focus();
        t.sel.focus();
        t.layout(false, { fire: false });
        window.dispatchEvent(new Event('resize'));
        flush();
        expect([where, ae() === t.th(2)]).toEqual([where, true]);
      }
    });
  });

  describe('R12-B B：已排队的 rAF 不吞掉新归属需要的交接', () => {
    for (const withResize of [true, false]) {
      it(`旧任务排队 → 本表新控件获得焦点 → 再次跨断点且没有 MQ change${withResize ? '（有 resize）' : '（也没有新的 resize）'} → flush 后按最新归属交接并同步 tabindex`, () => {
        const t = mount(`t-b-${withResize}`);
        t.sel.focus();
        t.layout(false, { fire: false }); // 800 → 1000：没有 MQ change
        t.sel.blur(); // 隐藏的下拉失焦到 BODY → 排一个 rAF（旧任务，基于下拉的归属）
        expect(rafQ.size).toBe(1);
        t.th(2).focus(); // 帧到来前，本表表头获得焦点（新的归属）
        t.layout(true, { fire: false }); // 1000 → 800：仍然没有 MQ change；表头只被裁切
        if (withResize) window.dispatchEvent(new Event('resize'));
        expect(rafQ.size).toBe(1); // 仍只有一个（合并），没有额外排队
        flush();
        expect(ae()).toBe(t.sel); // 新归属（表头在窄屏作废）需要的交接执行了
        expect(t.th(2).tabIndex).toBe(-1); // tabindex 按窄屏同步
        expect(t.table.querySelector<HTMLElement>('thead .th-resize')!.tabIndex).toBe(-1);
        expect(rafQ.size).toBe(0); // 不循环
        expect(t.events).toHaveLength(0);
      });
    }

    it('旧任务排队 → 本表新控件获得焦点且在当前断点有效 → flush 不覆盖新焦点、不调用 focus()', () => {
      const t = mount('t-b-keep');
      t.sel.focus();
      t.layout(false, { fire: false });
      t.sel.blur();
      t.th(4).focus();
      const spy = vi.spyOn(HTMLElement.prototype, 'focus');
      flush();
      expect(ae()).toBe(t.th(4));
      expect(spy).not.toHaveBeenCalled();
      expect(t.th(4).hasAttribute('tabindex')).toBe(false); // 宽屏 tabindex 已同步
    });

    it('撤销旧控制器（工具条被移除后重新初始化）时显式取消旧的已排队 rAF', () => {
      const t = mount('t-b-replace');
      t.sel.focus();
      t.layout(false, { fire: false });
      t.sel.blur();
      expect(rafQ.size).toBe(1);
      t.tools.remove(); // 移除工具条后再次初始化走「替换旧控制器」路径
      enhanceTable(t.table);
      expect(rafQ.size).toBe(0); // abort() 本身不会取消 rAF，这里由 abort 监听显式取消
    });
  });

  describe('R12-B C：工具条弹出面板（.table-pop__panel，真实组件 DOM）打开时阻挡交接', () => {
    const pop = (t: ReturnType<typeof mount>) => {
      const btn = t.tools.querySelector<HTMLButtonElement>('.table-pop > button[aria-controls]')!;
      const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
      return { btn, panel };
    };

    it('面板关闭（hidden）：不阻挡，交接照常；常驻可见的 role=group 节点不算阻挡', () => {
      const t = mount('t-c-closed');
      document.body.insertAdjacentHTML('beforeend', '<div role="group" aria-label="其它分组">x</div>');
      const { panel } = pop(t);
      expect(panel.hidden).toBe(true);
      expect(panel.getAttribute('role')).toBe('group');
      t.sel.focus();
      t.layout(false);
      expect(ae()).toBe(t.th(2));
    });

    it('面板打开后又关闭：不阻挡', () => {
      const t = mount('t-c-reclosed');
      const { btn, panel } = pop(t);
      btn.click();
      expect(panel.hidden).toBe(false);
      btn.click();
      expect(panel.hidden).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      t.sel.focus();
      t.layout(false);
      expect(ae()).toBe(t.th(2));
    });

    it('面板仍打开、但键盘焦点已离开面板回到下拉：仍阻挡交接（不依赖面板输入框自动聚焦）', () => {
      for (const fire of [true, false]) {
        const t = mount(`t-c-open-${fire}`);
        const { btn, panel } = pop(t);
        btn.click(); // 打开（组件会把焦点放进面板）
        expect(panel.hidden).toBe(false);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        t.sel.focus(); // 焦点离开面板（没有 pointerdown，面板保持打开）
        expect(panel.contains(ae())).toBe(false);
        expect(panel.hidden).toBe(false);
        t.layout(false, { fire });
        if (!fire) {
          window.dispatchEvent(new Event('resize'));
          flush();
        }
        expect([fire, ae() === t.th(2)]).toEqual([fire, false]);
        expect(ae()).toBe(t.sel); // 保留在原控件上（被阻挡 → 放弃记录）
      }
    });
  });
});
