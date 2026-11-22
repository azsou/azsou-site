/**
 * 下载按钮的平台识别：把最适合访客设备的那个按钮设为主按钮，并在提示行说明。
 * 只改 class 与提示文字（按钮本身早已渲染好、位置不变），不会造成布局移动。
 *
 * 首次推荐不播放按钮的颜色过渡：脚本在首帧之后才执行（WebKit 支持 <link rel="expect"> 渲染阻塞，首帧更早），
 * 换主按钮会让 .btn 的 background-color / color 过渡 160ms，访客看到一次闪烁，axe 恰好在过渡中取色就报
 * color-contrast（CI webkit a11y 首跑失败，docs/audits/evidence/ci/webkit-a11y-platform-transition-2026-10-29.md）。
 * 所以服务端给盒子带 data-dl-init（CSS 在它存在时关掉按钮过渡），换完 class 强制一次样式计算再移除。
 */
import { NATIVE_OS, PLATFORM_LABEL, detectOs, pickPlatform, type PlatformOs } from '@/lib/app-store';

export function currentOs() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectOs({
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform,
    maxTouchPoints: nav.maxTouchPoints,
  });
}

export function highlightPlatform(root: ParentNode) {
  const box = root.querySelector<HTMLElement>('[data-downloads]');
  if (!box) return;
  try {
    applyRecommendation(root, box);
  } finally {
    // 先让「无过渡」下的新样式生效，再恢复过渡（之后的悬停 / 按压照常有过渡）
    void box.offsetWidth;
    delete box.dataset.dlInit;
  }
}

function applyRecommendation(root: ParentNode, box: HTMLElement) {
  const buttons = [...box.querySelectorAll<HTMLElement>('[data-os]')];
  const available = buttons.map((b) => ({
    os: b.dataset.os as PlatformOs,
    url: b.hasAttribute('data-has-url') ? 'yes' : null,
  }));
  const os = currentOs();
  const pick = pickPlatform(available, os);
  if (!pick) return;
  for (const b of buttons) b.classList.toggle('btn--primary', b.dataset.os === pick);
  box.dataset.recommended = pick;
  const hint = root.querySelector<HTMLElement>('[data-dl-hint]');
  if (hint && os) {
    const mine = PLATFORM_LABEL[os];
    const hasNative = available.some((a) => a.url && NATIVE_OS.includes(a.os));
    hint.textContent =
      pick === os
        ? `已推荐 ${mine} 版本，经外链提示页下载。`
        : hasNative
          ? `没有 ${mine} 版本，已推荐「${PLATFORM_LABEL[pick]}」。`
          : `已推荐适合 ${mine} 的「${PLATFORM_LABEL[pick]}」，经外链提示页下载。`;
  }
}
