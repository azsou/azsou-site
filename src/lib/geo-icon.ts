/**
 * 几何兜底图标（T9.3，取代文字 Monogram）：资源确实缺失时，按 slug 生成确定的几何图形，
 * 底色用条目 hue（DESIGN-SYSTEM §6.4 / §7）。纯 SVG 字符串，构建期与浏览器端共用。
 */
const hash = (s: string) =>
  [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export function geoIconSvg(seed: string): string {
  const h = hash(seed);
  const pick = (n: number, shift: number) => (h >>> shift) % n;
  const shapes = [
    '<circle cx="12" cy="12" r="5.5"/>',
    '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
    '<path d="M12 5.5 18.5 17h-13z"/>',
    '<path d="M12 4.5 19.5 12 12 19.5 4.5 12z"/>',
    '<circle cx="12" cy="12" r="6" fill="none" stroke-width="2.5"/>',
    '<path d="M6 16.5a6 6 0 0 1 12 0z"/>',
  ];
  const a = shapes[pick(shapes.length, 0)];
  const b = shapes[pick(shapes.length, 8)];
  const dx = pick(3, 16) - 1;
  const dy = pick(3, 20) - 1;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-brand><g fill="#fff" stroke="#fff" opacity=".95">${a}</g><g fill="#fff" stroke="#fff" opacity=".45" transform="translate(${dx * 3} ${dy * 3}) scale(.55) translate(10 10)">${b}</g></svg>`;
}
