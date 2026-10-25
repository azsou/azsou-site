/// <reference types="astro/client" />

/** P8：变现与 Google 标签的构建期开关（全部可选，默认不设 = 关闭）。说明见 src/lib/ads.ts 与 docs/ADSENSE.md */
interface ImportMetaEnv {
  readonly PUBLIC_ADSENSE_CLIENT?: string;
  readonly PUBLIC_ADSENSE_SLOT_ARTICLE?: string;
  readonly PUBLIC_ADSENSE_SLOT_SIDEBAR?: string;
  readonly PUBLIC_ADSENSE_SLOT_LIST?: string;
  readonly PUBLIC_GA4_ID?: string;
  readonly PUBLIC_GSC_VERIFICATION?: string;
  readonly PUBLIC_CONTACT_EMAIL?: string;
}
