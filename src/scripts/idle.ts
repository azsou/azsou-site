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

/**
 * 等首次内容绘制（FCP）真的发生后再回调；load + 两帧并不保证已有内容绘制（CI 无头 Chromium 的英文页上
 * FCP 偶尔晚于两帧，空闲任务的 Supabase 请求于是落在 FCP 之前，Lighthouse 模拟把跨域连接算进 LCP，+0.9 s）。
 * 不支持 paint 计时的浏览器直接回调；最多等 3 秒。
 */
function afterFirstPaint(cb: () => void) {
  const painted = () => performance.getEntriesByName('first-contentful-paint').length > 0;
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('paint') ||
    painted()
  )
    return cb();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    po.disconnect();
    cb();
  };
  const po = new PerformanceObserver(() => {
    if (painted()) finish();
  });
  po.observe({ type: 'paint', buffered: true });
  setTimeout(finish, 3000);
}

export function whenIdle(fn: () => unknown, timeout = 1500) {
  const schedule = () => afterFirstPaint(() => requestAnimationFrame(() => requestAnimationFrame(idle)));
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

/**
 * 首屏以下的 island（评价区、评论区）：元素接近视口时才加载（提前约半屏）。
 * 提前一屏时，手机上首屏下方约 1.5 屏处的评价区会在页面加载时就触发（AI 工具详情页脚本预算 50 KB 超标），所以只提前半屏。
 * 只看一眼头部就离开的访客不用下载这部分脚本；滚动、目录锚点跳转、键盘 Tab 进入时都会触发。
 * 不支持 IntersectionObserver 的浏览器退回空闲时加载。
 */
export function whenNear(el: Element, fn: () => unknown, margin = '50% 0px') {
  if (!('IntersectionObserver' in window)) return whenIdle(fn);
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void run(fn);
    },
    { rootMargin: margin },
  );
  io.observe(el);
}
