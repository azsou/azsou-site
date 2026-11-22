#!/usr/bin/env python3
"""
自研应用图标家族（v2，2026-10-25）：手工 SVG → 1024 PNG 母版 → 512/256/128/64 的 WebP / AVIF。

统一规则（iOS 风格）：
  * 满版正方形，不带圆角与外阴影（圆角由页面 CSS 裁切成 squircle，见 docs/CONTENT.md §5）；
  * 背景：左上亮 → 右下深的线性渐变 + 顶部柔光 + 底部压暗，所有图标同一套光照；
  * 字形：居中、视觉重量一致（约占 56% 画幅），白色带极浅渐变 + 统一的下投影；
  * 每个应用一个专属字形与色相。
运行：python3 scripts/icons/own-apps.py  （生成 SVG 到 $ICON_OUT（默认 /tmp/az-icons），再由 render.mjs 栅格化）
"""
import os

OUT = os.environ.get('ICON_OUT', '/tmp/az-icons')
os.makedirs(OUT, exist_ok=True)

COMMON_DEFS = '''
<linearGradient id="bg" x1="0.08" y1="0" x2="0.92" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient>
<radialGradient id="hl" cx="0.32" cy="0.06" r="0.95"><stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="vg" x1="0" y1="0.55" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.22"/></linearGradient>
<linearGradient id="gw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="{gw2}"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="{shadow}" flood-opacity="0.45"/></filter>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
'''


def svg(c1, c2, glyph, gw2='#eef2ff', shadow='#000000', extra_defs=''):
    defs = COMMON_DEFS.format(c1=c1, c2=c2, gw2=gw2, shadow=shadow) + extra_defs
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>{defs}</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<rect width="1024" height="1024" fill="url(#hl)"/>
<rect width="1024" height="1024" fill="url(#vg)"/>
{glyph}
</svg>'''


ICONS = {}

# 1. FableMotion —— 关键帧时间轴 + 运动路径（洋葱皮残影）
ICONS['fablemotion'] = svg('#a78bfa', '#4338ca', '''
<g filter="url(#sh)" transform="translate(0 24)">
  <path d="M250 640 C 330 360, 560 250, 772 300" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="22" stroke-linecap="round" stroke-dasharray="2 46"/>
  <circle cx="318" cy="505" r="40" fill="#fff" fill-opacity="0.28"/>
  <circle cx="440" cy="378" r="50" fill="#fff" fill-opacity="0.45"/>
  <circle cx="590" cy="310" r="60" fill="#fff" fill-opacity="0.68"/>
  <circle cx="760" cy="298" r="78" fill="url(#gw)"/>
  <rect x="212" y="728" width="600" height="26" rx="13" fill="#fff" fill-opacity="0.9"/>
  <rect x="300" y="686" width="76" height="76" rx="12" transform="rotate(45 338 724) translate(0 3)" fill="url(#gw)"/>
  <rect x="500" y="690" width="68" height="68" rx="11" transform="rotate(45 534 724) translate(0 7)" fill="url(#gw)"/>
  <rect x="690" y="690" width="68" height="68" rx="11" transform="rotate(45 724 724) translate(0 7)" fill="#fde68a"/>
</g>''', gw2='#ede9fe', shadow='#1e1b4b')

# 2. Image Atlas Pro —— 图片框（山 + 太阳）+ 放大镜
ICONS['image-atlas-pro'] = svg('#5eead4', '#0f766e', '''
<defs><clipPath id="frame"><rect x="196" y="236" width="520" height="420" rx="64"/></clipPath></defs>
<g filter="url(#sh)">
  <rect x="196" y="236" width="520" height="420" rx="64" fill="url(#gw)"/>
  <g clip-path="url(#frame)">
    <path d="M196 600 L360 430 L470 540 L560 452 L716 610 L716 656 L196 656 Z" fill="#14b8a6"/>
    <path d="M196 656 L360 486 L470 596 L560 508 L716 666 Z" fill="#0f766e" fill-opacity="0.55"/>
  </g>
  <circle cx="580" cy="350" r="44" fill="#fbbf24"/>
  <circle cx="676" cy="626" r="138" fill="#0d5e57" fill-opacity="0.92" stroke="#fff" stroke-width="40"/>
  <circle cx="676" cy="626" r="98" fill="#fff" fill-opacity="0.12"/>
  <path d="M640 570 a70 70 0 0 1 70 -6" fill="none" stroke="#fff" stroke-opacity="0.75" stroke-width="16" stroke-linecap="round"/>
  <path d="M780 730 L846 796" stroke="#fff" stroke-width="56" stroke-linecap="round"/>
</g>''', gw2='#ccfbf1', shadow='#042f2e')

# 3. Capture Kit —— 取景框四角 + 录制点
ICONS['capture-kit'] = svg('#60a5fa', '#1d4ed8', '''
<g filter="url(#sh)" fill="none" stroke="url(#gw)" stroke-width="54" stroke-linecap="round" stroke-linejoin="round">
  <path d="M222 380 V300 a78 78 0 0 1 78 -78 H380"/>
  <path d="M644 222 H724 a78 78 0 0 1 78 78 V380"/>
  <path d="M802 644 V724 a78 78 0 0 1 -78 78 H644"/>
  <path d="M380 802 H300 a78 78 0 0 1 -78 -78 V644"/>
</g>
<g filter="url(#sh)">
  <circle cx="512" cy="512" r="168" fill="url(#gw)"/>
  <circle cx="512" cy="512" r="116" fill="#ef4444"/>
  <circle cx="512" cy="512" r="116" fill="url(#hl)"/>
</g>''', gw2='#dbeafe', shadow='#172554')

# 4. 单文件工具箱 —— 一张文件 + 2×2 工具格
ICONS['single-file-toolbox'] = svg('#fcd34d', '#ea580c', '''
<g filter="url(#sh)">
  <path d="M286 190 H600 L738 328 V790 a44 44 0 0 1 -44 44 H286 a44 44 0 0 1 -44 -44 V234 a44 44 0 0 1 44 -44 Z" fill="url(#gw)"/>
  <path d="M600 190 V284 a44 44 0 0 0 44 44 H738 Z" fill="#fdba74"/>
  <rect x="318" y="410" width="160" height="160" rx="40" fill="#f97316"/>
  <rect x="502" y="410" width="160" height="160" rx="40" fill="#fb923c" fill-opacity="0.75"/>
  <rect x="318" y="594" width="160" height="160" rx="40" fill="#fb923c" fill-opacity="0.75"/>
  <rect x="502" y="594" width="160" height="160" rx="40" fill="#ea580c"/>
  <path d="M362 490 h72 M398 454 v72" stroke="#fff" stroke-width="22" stroke-linecap="round"/>
  <circle cx="582" cy="674" r="34" fill="none" stroke="#fff" stroke-width="20"/>
</g>''', gw2='#fff7ed', shadow='#7c2d12')

# 5. 程序化声场 —— 对称波形 + 声场环
ICONS['procedural-soundfield'] = svg('#6ee7b7', '#047857', '''
<g fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="18">
  <circle cx="512" cy="512" r="330"/>
  <circle cx="512" cy="512" r="250" stroke-opacity="0.3"/>
</g>
<g filter="url(#sh)" fill="url(#gw)">
  <rect x="263" y="452" width="54" height="120" rx="27"/>
  <rect x="343" y="372" width="54" height="280" rx="27"/>
  <rect x="423" y="292" width="54" height="440" rx="27"/>
  <rect x="503" y="232" width="54" height="560" rx="27" fill="#fde68a"/>
  <rect x="583" y="332" width="54" height="360" rx="27"/>
  <rect x="663" y="412" width="54" height="200" rx="27"/>
  <rect x="743" y="472" width="54" height="80" rx="27"/>
</g>''', gw2='#d1fae5', shadow='#022c22')

# 6. 职业技能树工具 —— 1 → 2 → 3 的技能节点树
ICONS['skill-tree-tool'] = svg('#f0abfc', '#7e22ce', '''
<g filter="url(#sh)">
  <g stroke="#fff" stroke-opacity="0.85" stroke-width="26" stroke-linecap="round" fill="none">
    <path d="M512 770 L372 560 M512 770 L652 560"/>
    <path d="M372 560 L262 330 M372 560 L512 300 M652 560 L762 330"/>
  </g>
  <circle cx="512" cy="770" r="74" fill="url(#gw)"/>
  <circle cx="372" cy="560" r="64" fill="url(#gw)"/>
  <circle cx="652" cy="560" r="64" fill="url(#gw)"/>
  <circle cx="262" cy="330" r="54" fill="url(#gw)"/>
  <circle cx="762" cy="330" r="54" fill="#fff" fill-opacity="0.45" stroke="#fff" stroke-width="14"/>
  <circle cx="512" cy="300" r="78" fill="#fde68a"/>
  <path d="M512 252 l15 31 34 5 -25 24 6 34 -30 -16 -30 16 6 -34 -25 -24 34 -5 z" fill="#a21caf"/>
</g>''', gw2='#fae8ff', shadow='#3b0764')

# 7. Sub2API —— 终端提示符 + 双向转发（深色底 + 青色）
ICONS['sub2api'] = svg('#334155', '#020617', '''
<defs><linearGradient id="cy" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a5f3fc"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<g opacity="0.5" filter="url(#glow)"><path d="M262 460 L452 610 L262 760" fill="none" stroke="#22d3ee" stroke-width="66" stroke-linecap="round" stroke-linejoin="round"/></g>
<g filter="url(#sh)">
  <path d="M262 460 L452 610 L262 760" fill="none" stroke="url(#cy)" stroke-width="66" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="510" y="720" width="262" height="66" rx="33" fill="url(#gw)"/>
  <g stroke-width="36" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M300 236 H724 M668 182 L724 236 L668 290" stroke="#fff"/>
    <path d="M724 346 H300 M356 292 L300 346 L356 400" stroke="#67e8f9" stroke-opacity="0.85"/>
  </g>
</g>''', gw2='#cffafe', shadow='#000000')

# 8. Hermes 回归验收器 —— 盾牌 + 对勾 + 背景矩阵网格
ICONS['hermes'] = svg('#fb923c', '#dc2626', '''
<g stroke="#fff" stroke-opacity="0.16" stroke-width="10">
  <path d="M152 312 H872 M152 512 H872 M152 712 H872 M312 152 V872 M512 152 V872 M712 152 V872"/>
</g>
<g filter="url(#sh)">
  <path d="M512 196 L760 286 V500 C760 660 652 772 512 830 C372 772 264 660 264 500 V286 Z" fill="url(#gw)"/>
  <path d="M512 252 L708 324 V500 C708 628 624 718 512 768 Z" fill="#fff" fill-opacity="0.0"/>
  <path d="M398 512 L482 596 L640 430" fill="none" stroke="#ea580c" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/>
</g>''', gw2='#ffedd5', shadow='#450a0a')

for slug, s in ICONS.items():
    with open(os.path.join(OUT, f'{slug}.svg'), 'w') as f:
        f.write(s)
print('wrote', len(ICONS))
