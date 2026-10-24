/**
 * 非首屏 island 在页面 load、再过两帧（首屏已绘制）、浏览器空闲时才加载（动态 import）。
 * 这样首屏绘制（FCP / LCP）不会被数据层等脚本的解析执行推迟——移动端 LCP 预算 < 2.0s。
 */
export function whenIdle(fn: () => unknown, timeout = 1500) {
  const schedule = () => requestAnimationFrame(() => requestAnimationFrame(idle));
  const idle = () => {
    const ric = (
      window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    if (ric) ric(() => void fn(), { timeout });
    else setTimeout(() => void fn(), 1);
  };
  if (document.readyState === 'complete') schedule();
  else addEventListener('load', schedule, { once: true });
}
