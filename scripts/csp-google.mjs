#!/usr/bin/env node
/**
 * 在 vercel.json 的页面 CSP 上开 / 关 Google 标签来源（P8 T8.3）。CSP 是静态响应头，不能随环境变量在构建时变化，
 * 所以启用 AdSense / GA4 时需要显式运行这个脚本并提交 vercel.json（可审查的改动）；默认（关闭）时 CSP 保持严格。
 *
 *   node scripts/csp-google.mjs status                 显示当前状态
 *   node scripts/csp-google.mjs on --ads [--ga]        放开 AdSense（与 GA4）需要的来源
 *   node scripts/csp-google.mjs on --ga                只放开 GA4
 *   node scripts/csp-google.mjs off                    恢复严格 CSP（与开启前逐字一致）
 *   node scripts/csp-google.mjs print --ads --ga       只打印结果，不写文件
 *   node scripts/csp-google.mjs check                  按环境变量核对：设了 PUBLIC_ADSENSE_CLIENT / PUBLIC_GA4_ID 但 CSP 没放开 → 失败
 *
 * 构建（npm run build 的 prebuild）会运行 check：变量设了却忘了改 CSP，构建直接失败，不会上线一个广告被拦截的站。
 */
import fs from 'node:fs';
import { applyGoogleCsp, googleCspState } from './google-csp.mjs';

const CSP_SOURCE = '/((?!_astro/|pagefind/|cms/|api/cms/).*)';
const [cmd = 'status', ...rest] = process.argv.slice(2);
const file = rest.find((a) => a.endsWith('.json')) || 'vercel.json';
const vercel = JSON.parse(fs.readFileSync(file, 'utf8'));
const header = vercel.headers
  .find((h) => h.source === CSP_SOURCE)
  ?.headers.find((h) => h.key === 'Content-Security-Policy');
if (!header) {
  console.error(`✗ ${file} 里找不到页面 CSP（${CSP_SOURCE}）`);
  process.exit(1);
}
const state = googleCspState(header.value);
const want = { ads: rest.includes('--ads'), ga: rest.includes('--ga') };

if (cmd === 'status') {
  console.log(
    `AdSense 来源：${state.ads ? '已放开' : '未放开'}；GA4 来源：${state.ga ? '已放开' : '未放开'}`,
  );
} else if (cmd === 'print') {
  console.log(applyGoogleCsp(header.value, want));
} else if (cmd === 'on' || cmd === 'off') {
  if (cmd === 'on' && !want.ads && !want.ga) {
    console.error('用法：csp-google.mjs on --ads [--ga] | on --ga');
    process.exit(1);
  }
  header.value = applyGoogleCsp(header.value, cmd === 'on' ? want : { ads: false, ga: false });
  fs.writeFileSync(file, JSON.stringify(vercel, null, 2) + '\n');
  const s = googleCspState(header.value);
  console.log(`已写入 ${file}：AdSense ${s.ads ? '开' : '关'} · GA4 ${s.ga ? '开' : '关'}`);
} else if (cmd === 'check') {
  const ads = /^ca-pub-\d{16}$/.test((process.env.PUBLIC_ADSENSE_CLIENT ?? '').trim());
  const ga = /^G-[A-Z0-9]{4,12}$/.test((process.env.PUBLIC_GA4_ID ?? '').trim());
  const miss = [];
  if (ads && !state.ads)
    miss.push('AdSense（node scripts/csp-google.mjs on --ads' + (ga ? ' --ga' : '') + '）');
  if (ga && !state.ga) miss.push('GA4（node scripts/csp-google.mjs on ' + (ads ? '--ads ' : '') + '--ga）');
  if (miss.length && !process.env.AZ_SKIP_CSP_GOOGLE_CHECK) {
    console.error(
      `✗ 设置了 Google 环境变量，但 vercel.json 的 CSP 没有放开：${miss.join('；')}。运行括号里的命令并提交 vercel.json。`,
    );
    process.exit(1);
  }
  if ((state.ads && !ads) || (state.ga && !ga))
    console.warn(
      '! vercel.json 的 CSP 放开了 Google 来源，但对应环境变量没有设置（不影响运行；不再需要时运行 off 恢复严格 CSP）',
    );
  console.log('✓ Google CSP 与环境变量一致');
} else {
  console.error(`未知命令 ${cmd}`);
  process.exit(1);
}
