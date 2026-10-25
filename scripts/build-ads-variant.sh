#!/usr/bin/env bash
# 广告开启变体（P8 T8.3）：用假的 AdSense / GA4 / GSC 配置构建到 dist-ads/，并生成放开 Google 来源的 vercel.json 副本，
# 供 npm run test:ads（产物检查）与 tests/e2e/ads.spec.ts（广告位尺寸、与按钮的距离、CSP 实测）使用。
# 正式站点永远不会用到这些值：ca-pub-0000000000000000 不是有效的发布商 ID。
set -euo pipefail
export PUBLIC_ADSENSE_CLIENT=ca-pub-0000000000000000
export PUBLIC_ADSENSE_SLOT_ARTICLE=1111111111
export PUBLIC_ADSENSE_SLOT_SIDEBAR=2222222222
export PUBLIC_ADSENSE_SLOT_LIST=3333333333
export PUBLIC_GA4_ID=G-TEST000000
export PUBLIC_GSC_VERIFICATION=dummy-gsc-verification-token
cp vercel.json dist-ads.vercel.json
node scripts/csp-google.mjs on --ads --ga dist-ads.vercel.json
rm -rf dist-ads
# 构建会改写 .vercel/output（Vercel 适配器），只在 CI 或测试时运行；之后需要线上产物请重新 npm run build
npx astro build --outDir dist-ads
node scripts/check-csp.mjs --vercel dist-ads.vercel.json dist-ads/client
