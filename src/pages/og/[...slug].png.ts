import type { APIRoute, GetStaticPaths } from 'astro';
import { getApps, getArticles, getGames, getTools, getVideos, getWorks, forum } from '@/lib/content';
import { AI_CATEGORIES, CATEGORIES, PRICE_LABEL } from '@/lib/app-store';
import { VIDEO_CATEGORIES, thumbPath } from '@/lib/videos';
import { EN_AI_CATEGORY, EN_CATEGORY, EN_PRICE, EN_VIDEO_CATEGORY } from '@/lib/i18n-labels';
import { OG_SECTIONS } from '@/lib/og-routes';
import { ogPng, type OgSpec } from '@/lib/og';

/**
 * 按页面类型的 OG 分享图（T9.4，DESIGN-SYSTEM §19.1）：/og/<类型>/<slug>.png、/og/en/<类型>/<slug>.png、/og/s/<栏目>.png。
 * 路径由 lib/routes.ts 的 og* 函数给出；每类页面一套模板，中英两套文案。
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const [apps, tools, games, videos, articles, works] = await Promise.all([
    getApps(),
    getTools(),
    getGames(),
    getVideos(),
    getArticles(),
    getWorks(),
  ]);
  const P: { params: { slug: string }; props: { spec: OgSpec } }[] = [];
  const add = (slug: string, spec: OgSpec) => P.push({ params: { slug }, props: { spec } });
  const tagline = (d: { tagline: string }) => d.tagline;

  for (const a of apps) {
    const d = a.data;
    const price = d.price.model === 'paid' && d.price.amount ? d.price.amount : PRICE_LABEL[d.price.model];
    add(`app/${a.id}`, {
      kind: 'app',
      title: d.title,
      tagline: tagline(d),
      meta: `${CATEGORIES[d.category]} · ${price}`,
      icon: d.icon.src,
    });
    if (d.en)
      add(`en/app/${a.id}`, {
        kind: 'app',
        title: d.en.title ?? d.title,
        tagline: d.en.subtitle ?? '',
        meta: `${EN_CATEGORY[d.category]} · ${d.price.model === 'paid' && d.price.amount ? d.price.amount : EN_PRICE[d.price.model]}`,
        icon: d.icon.src,
      });
  }
  for (const t of tools) {
    const d = t.data;
    const cat = d.categories[0];
    add(`ai/${t.id}`, {
      kind: 'app',
      title: d.title,
      tagline: tagline(d),
      meta: `${AI_CATEGORIES[cat]} · ${PRICE_LABEL[d.price.model]}`,
      icon: d.icon.src,
    });
    if (d.en)
      add(`en/ai/${t.id}`, {
        kind: 'app',
        title: d.en.title ?? d.title,
        tagline: d.en.subtitle ?? '',
        meta: `${EN_AI_CATEGORY[cat]} · ${EN_PRICE[d.price.model]}`,
        icon: d.icon.src,
      });
  }
  for (const g of games) {
    const d = g.data;
    const image = `/art/${d.art}.svg`;
    add(`game/${g.id}`, { kind: 'cover', title: d.title, meta: `${d.kind} · ${d.genre}`, image, dark: true });
    if (d.en)
      add(`en/game/${g.id}`, {
        kind: 'cover',
        title: d.en.title ?? d.title,
        meta: `${d.en.kind} · ${d.en.genre}`,
        image,
        dark: true,
      });
  }
  for (const v of videos) {
    const d = v.data;
    const image = thumbPath(v.id, 960, 'webp');
    const tail = d.duration ? ` · ${d.duration}` : '';
    add(`video/${v.id}`, {
      kind: 'cover',
      title: d.title,
      meta: `${d.channel.name}${tail}`,
      tagline: VIDEO_CATEGORIES[d.categories[0]],
      image,
      dark: true,
    });
    if (d.en)
      add(`en/video/${v.id}`, {
        kind: 'cover',
        title: d.originalTitle,
        meta: `${d.channel.name}${tail}`,
        tagline: EN_VIDEO_CATEGORY[d.categories[0]],
        image,
        dark: true,
      });
  }
  for (const a of articles) {
    const d = a.data;
    add(`article/${a.id}`, {
      kind: 'article',
      title: d.title,
      eyebrow: d.category,
      meta: `${d.author} · ${d.readingMinutes} 分钟阅读`,
    });
  }
  for (const w of works) {
    const d = w.data;
    add(`work/${w.id}`, {
      kind: 'cover',
      title: d.title,
      meta: `${d.kind} · ${d.status}`,
      image: `/art/${d.art}.svg`,
    });
  }
  for (const s of forum.seeds) {
    const cat = forum.categories.find((c) => c.id === s.category);
    const n = s.replies.length;
    add(`forum/${s.id}`, {
      kind: 'article',
      title: s.title,
      eyebrow: `论坛 · ${cat?.name ?? ''}`,
      meta: n ? `${n} 条回复` : `${s.author}`,
    });
  }
  const appIcons = apps.slice(0, 4).map((a) => a.data.icon.src);
  const toolIcons = tools.slice(0, 4).map((t) => t.data.icon.src);
  for (const [id, s] of Object.entries(OG_SECTIONS)) {
    add(`s/${id}`, {
      kind: 'section',
      title: s.title,
      tagline: s.tagline,
      icons:
        s.icons === 'tools'
          ? toolIcons
          : s.icons === 'mixed'
            ? [...appIcons.slice(0, 2), ...toolIcons.slice(0, 2)]
            : appIcons,
    });
  }
  return P;
};

export const GET: APIRoute = async ({ props }) => {
  const png = await ogPng((props as { spec: OgSpec }).spec);
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
