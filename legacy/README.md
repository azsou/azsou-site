# azsou.com · AZ Studio（V72）

单文件站点 + Supabase 后端。`index.html` 即整站；推送到 main 分支 Vercel 自动重新部署。

## 日常更新流程

- 改内容/代码：在源码树（az-studio-src）里改 → `npm run build` → 把 `dist/az-studio.html` 覆盖为本仓库 `index.html` → `git commit && git push`。
- 只改站点数据：也可以直接在 `azsou.com/#/admin` 里编辑（云端覆盖即时生效，无需部署）；要沉淀回文件时用后台「站点工具 → 静态化」下载覆盖 `index.html` 再推送。
- 发新版本记得同步 `az-sw.js` 里的 `CACHE` 版本号。

## 文件清单

| 文件 | 作用 |
|---|---|
| index.html | 整站单文件（V72） |
| az-sw.js | Service Worker（离线 + 更新提示，CACHE=az-studio-v72） |
| vercel.json | SPA 回落与缓存头 |
| og/ · og-image.png | 文章分享卡 ×12 + 站点默认图 |
| sitemap.xml · rss.xml · robots.txt | SEO（域名 azsou.com，后台工具可再生成） |
| manifest.webmanifest · favicon.svg | PWA 清单与图标 |
