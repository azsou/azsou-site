/**
 * 下载按钮的平台识别：把最适合访客设备的那个按钮设为主按钮，并在提示行说明。
 * 只改 class 与提示文字（按钮本身早已渲染好、位置不变），不会造成布局移动。
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
        ? `已为你的设备（${mine}）推荐对应版本。下载前会经过外链提示页。`
        : hasNative
          ? `没有 ${mine} 版本，已推荐可在你的设备上使用的「${PLATFORM_LABEL[pick]}」。`
          : `已推荐可在你的设备（${mine}）上使用的「${PLATFORM_LABEL[pick]}」。下载前会经过外链提示页。`;
  }
}
