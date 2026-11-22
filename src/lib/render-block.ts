/**
 * 详情页头部结束标记的 id：DetailHero 把它作为头部最后一个子元素输出，Base 用
 * `<link rel="expect" href="#detail-hero-end" blocking="render">` 让浏览器在它解析出来之前不画首帧，
 * 避免「操作卡只解析了一半、垂直居中偏下」的那一帧（桌面 CLS，见 Base.astro renderBlockUntil 注释）。
 */
export const DETAIL_HERO_END_ID = 'detail-hero-end';
