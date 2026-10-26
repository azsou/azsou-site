// 栅格化：$ICON_OUT/*.svg → public/apps/icons/<slug>.png（1024 母版）+ <slug>-{512,256,128,64}.{webp,avif}
// 用法：node scripts/icons/render.mjs [srcDir] [destDir]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const src = process.argv[2] || process.env.ICON_OUT || '/tmp/az-icons';
const dest = process.argv[3] || 'public/apps/icons';
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(src).filter((x) => x.endsWith('.svg'))) {
  const slug = f.replace(/\.svg$/, '');
  const png = new Resvg(readFileSync(join(src, f)), { fitTo: { mode: 'width', value: 1024 } })
    .render()
    .asPng();
  const master = await sharp(png).png({ compressionLevel: 9, palette: false }).toBuffer();
  writeFileSync(join(dest, `${slug}.png`), master);
  for (const s of [512, 256, 128, 64]) {
    const r = sharp(master).resize(s, s, { kernel: 'lanczos3' });
    await r
      .clone()
      .webp({ quality: 86, effort: 6 })
      .toFile(join(dest, `${slug}-${s}.webp`));
    await r
      .clone()
      .avif({ quality: 62, effort: 6 })
      .toFile(join(dest, `${slug}-${s}.avif`));
  }
  console.log('icon', slug);
}
