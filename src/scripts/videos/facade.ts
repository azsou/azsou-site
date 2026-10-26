/**
 * 视频播放器 facade（见 src/components/videos/VideoPlayer.astro）。
 * 点击缩略图（或章节时间点）时才创建 iframe：在此之前页面不向视频平台发任何请求。
 * - 嵌入地址来自构建期写好的 data-embed（youtube-nocookie.com / player.bilibili.com），这里只追加起始时间；
 * - 章节按钮 [data-seek] 在播放器未加载时以该时间点加载，已加载时换成带起始时间的地址；
 * - 加载后把焦点移到 iframe，读屏用户能直接操作播放器。
 */
function withStart(embed: string, provider: string, seconds: number): string {
  const u = new URL(embed);
  const t = String(Math.max(0, Math.floor(seconds)));
  if (provider === 'bilibili') u.searchParams.set('t', t);
  else u.searchParams.set('start', t);
  return u.toString();
}

export function load(box: HTMLElement, start = 0): HTMLIFrameElement {
  const embed = box.dataset.embed!;
  const provider = box.dataset.provider ?? 'youtube';
  const src = start > 0 ? withStart(embed, provider, start) : embed;
  let frame = box.querySelector<HTMLIFrameElement>('iframe');
  if (frame) {
    frame.src = src;
  } else {
    frame = document.createElement('iframe');
    frame.src = src;
    frame.title = `视频播放器：${box.dataset.title ?? ''}`;
    frame.allow =
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.className = 'video-player__frame';
    box.replaceChildren(frame);
    box.dataset.loaded = 'yes';
  }
  frame.focus();
  return frame;
}

const boxes = [...document.querySelectorAll<HTMLElement>('[data-video-facade]')];
for (const box of boxes) {
  box.querySelector<HTMLAnchorElement>('[data-facade-link]')?.addEventListener('click', (e) => {
    // 新标签页 / 新窗口打开（Ctrl / ⌘ / 中键）时按普通链接处理
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    load(box);
  });
  box.dataset.ready = 'yes';
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-seek]')) {
  btn.disabled = false;
  btn.addEventListener('click', () => {
    const box = boxes[0];
    if (!box) return;
    load(box, Number(btn.dataset.seek) || 0);
    box.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  });
}
