import type { AuthProvider } from '@/lib/data/types';
import { classifySupabaseUrl, supabaseConfig } from '@/lib/supabase-config';

// Pilot only: this is not a generic picker. Never build a media URL from an article or user input.
const objectPath = '/storage/v1/object/authenticated/az-cms-draft-media-sb05/sb05-check-864e09ae.png';
const digest = '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460';
const length = 68;

async function verifiedImage(response: Response): Promise<Blob> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || response.redirected || type !== 'image/png' || !response.body) {
    throw new Error('Unexpected private image response');
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(length);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.length > length - used) {
        await reader.cancel();
        throw new Error('Unexpected private image size');
      }
      bytes.set(part.value, used);
      used += part.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (used !== length) throw new Error('Incomplete private image');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('') !== digest) {
    throw new Error('Unexpected private image digest');
  }
  return new Blob([bytes], { type: 'image/png' });
}

// Called only after the existing article editor's admin + test/local gates. Storage enforces authorization.
export function attachPrivateMediaPreview(root: HTMLElement, auth: AuthProvider, owner: string) {
  const config = supabaseConfig();
  const target = classifySupabaseUrl(config.url)?.target;
  if (target !== 'test' && target !== 'local') return;
  const endpoint = new URL(objectPath, config.url);
  const panel = document.createElement('section');
  panel.className = 'panel form';
  panel.setAttribute('aria-labelledby', 'private-media-heading');
  const heading = document.createElement('h2');
  heading.id = 'private-media-heading';
  heading.textContent = '私图预览测试';
  const hint = document.createElement('p');
  hint.className = 'field__hint';
  hint.textContent = '仅预览一张合成测试图，不上传、不关联文章。';
  const buttons = document.createElement('div');
  buttons.className = 'btn-row';
  const open = document.createElement('button');
  const close = document.createElement('button');
  open.type = close.type = 'button';
  open.className = close.className = 'btn';
  open.textContent = '预览测试私图';
  close.textContent = '关闭私图预览';
  const note = document.createElement('p');
  note.className = 'form-status';
  note.setAttribute('role', 'status');
  const image = document.createElement('img');
  image.alt = '合成测试私图';
  image.width = image.height = 1;
  image.hidden = true;
  close.disabled = true;
  buttons.append(open, close);
  panel.append(heading, hint, buttons, note, image);

  let epoch = 0;
  let active = true;
  let controller: AbortController | undefined;
  let objectUrl: string | undefined;
  let timer: number | undefined;
  function session() {
    const s = auth.getSession();
    return active && s?.user.id === owner && s.accessToken && s.expiresAt * 1000 > Date.now() ? s : null;
  }
  function clear(message: string) {
    epoch++;
    controller?.abort();
    controller = undefined;
    window.clearTimeout(timer);
    timer = undefined;
    image.hidden = true;
    image.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
    note.textContent = message;
    open.disabled = !session();
    close.disabled = true;
  }
  function valid(ticket: number) {
    return ticket === epoch && root.isConnected && !document.hidden && session() !== null;
  }
  async function preview() {
    const s = session();
    if (!s || document.hidden || !root.isConnected || open.disabled || controller || objectUrl) return;
    const ticket = ++epoch;
    controller = new AbortController();
    open.disabled = true;
    close.disabled = false;
    note.textContent = '正在读取测试私图…';
    timer = window.setTimeout(() => clear('预览已结束。'), Math.min(60_000, s.expiresAt * 1000 - Date.now()));
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { apikey: config.key, Authorization: `Bearer ${s.accessToken}`, Accept: 'image/png' },
        signal: controller.signal,
      });
      if (!valid(ticket)) return;
      const blob = await verifiedImage(response);
      if (!valid(ticket)) return;
      objectUrl = URL.createObjectURL(blob);
      image.src = objectUrl;
      await image.decode();
      if (!valid(ticket)) return;
      if (image.naturalWidth !== 1 || image.naturalHeight !== 1) throw new Error('Unexpected dimensions');
      image.hidden = false;
      note.textContent = '已核对并显示测试私图（1 × 1 像素）。';
    } catch {
      if (ticket === epoch) clear('未能预览测试私图。未改用公开地址。');
    } finally {
      if (ticket === epoch) controller = undefined;
    }
  }
  if (!session()) return;
  root.append(panel);
  open.addEventListener('click', () => void preview());
  close.addEventListener('click', () => {
    clear('预览已关闭。');
    open.focus();
  });
  auth.onChange((s) => {
    if (s?.user.id !== owner) {
      active = false;
      panel.hidden = true;
    }
    clear('会话已变化，预览已关闭。');
  });
  window.addEventListener('pagehide', () => clear('预览已关闭。'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear('预览已关闭。');
  });
}
