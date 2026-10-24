/**
 * 非首屏 island 在页面 load、再过两帧（首屏已绘制）、浏览器空闲时才加载（动态 import）。
 * 这样首屏绘制（FCP / LCP）不会被数据层等脚本的解析执行推迟——移动端 LCP 预算 < 2.0s。
 *
 * 模块下载失败时（Firefox 在页面离开时中止未下载完的模块，会报「error loading dynamically imported module」；
 * 也可能是网络抖动或部署切换瞬间）隔 1 秒重试一次：页面已经离开的话定时器不会再执行，什么也不会报；
 * 页面还在就再加载一次，仍失败才抛出。模块里的其他异常照常抛出（不重试，避免初始化跑两遍）。
 */
// Chromium / Firefox / Safari 各自的「动态模块加载失败」提示
const LOAD_ERROR = /dynamically imported module|importing a module script failed|module script/i;

async function run(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof TypeError && LOAD_ERROR.test(e.message))) throw e;
    await new Promise((r) => setTimeout(r, 1000));
    await fn();
  }
}

export function whenIdle(fn: () => unknown, timeout = 1500) {
  const schedule = () => requestAnimationFrame(() => requestAnimationFrame(idle));
  const idle = () => {
    const ric = (
      window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) ric(() => void run(fn), { timeout });
    else setTimeout(() => void run(fn), 1);
  };
  if (document.readyState === 'complete') schedule();
  else addEventListener('load', schedule, { once: true });
}
