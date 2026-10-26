import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import {
  AI_CATEGORY_IDS,
  CATEGORY_IDS,
  LINK_TYPES,
  PLATFORMS,
  PRICE_MODELS,
  type AiCategory,
  type Category,
} from './lib/app-store';
import { HUES } from './lib/hue';
import { zhLength, zhRangeText } from './lib/zh-length';
import {
  VIDEO_CATEGORY_IDS,
  VIDEO_ID_RE,
  VIDEO_PROVIDERS,
  parseClock,
  type VideoCategory,
} from './lib/videos';

const hue = z.enum(HUES);
/** 卡片字段字数（DESIGN-SYSTEM §10，T9.5）：按 zhLength 计，超出即构建失败 */
const zh = (max: number, min?: number) =>
  z.string().refine((v) => zhLength(v) <= max && (!min || zhLength(v) >= min), {
    message: `字数应为 ${zhRangeText(min, max)}`,
  });
const date = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, '日期格式应为 YYYY-MM 或 YYYY-MM-DD');
const fact = z.object({ label: z.string(), value: z.string() });
const slugRef = z.string().regex(/^[a-z0-9-]+$/);

/**
 * 英文版（T7.6，/en/）：只放如实翻译的短文案（标题 / 副标题 / 简介），正文仍是中文——英文详情页显示简介并链接到中文全文。
 * 不写 = 该条目没有英文版（不生成 /en/ 页面）。
 */
const enText = z.object({
  /** 英文名与中文名相同时不写 */
  title: z.string().optional(),
  subtitle: z.string().max(60).optional(),
  summary: z.string().min(20).max(420),
});

export const statusClass = z.enum(['active', 'review', 'stable', 'experiment']);

/* 正文均为迁移来的 HTML，页面用 set:html 原样输出（不经 Markdown 二次处理） */

const PLATFORM_OS = z.enum(PLATFORMS);
const httpsUrl = z.string().url().startsWith('https://', '外链必须是 https');
const localOrHttps = z.union([z.string().regex(/^\/[^/]/, '站内路径以 / 开头'), httpsUrl]);

/** 每个平台一项：下载 / 打开方式。没有 url = 开发者还没提供（页面显示「暂未提供」，不出现可点的下载按钮） */
const appPlatform = z
  .object({
    os: PLATFORM_OS,
    /** 该平台的版本（不同平台可能不同）；第三方工具跟随官方更新时可以不写 */
    version: z.string().optional(),
    /** 安装包大小，如「18.4 MB」；没有就不写 */
    size: z.string().optional(),
    /** 系统要求，如「Windows 10 及以上」「Chrome 120+」 */
    requirements: z.string().optional(),
    linkType: z.enum(LINK_TYPES),
    url: httpsUrl.optional(),
    /** 直链必须附 SHA-256（64 位十六进制） */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'SHA-256 应为 64 位十六进制')
      .optional(),
    arch: z.string().optional(),
    /** 按钮旁的补充说明 */
    note: z.string().optional(),
    /**
     * 还没有下载地址时的状态：coming-soon = 即将推出（按钮禁用 +「上线通知」）；
     * 不写 = 暂未提供。有 url 时忽略。
     */
    availability: z.enum(['coming-soon']).optional(),
  })
  .refine((p) => p.linkType !== 'direct' || !p.url || !!p.sha256, {
    message: '直链（linkType: direct）必须提供 sha256',
  });

/** 图标：站内路径，正方形；页面用 CSS 裁成 squircle（图片本身不要做圆角） */
const icon = z.object({
  /** /apps/icons/<slug>.svg|png|webp（自研应用，建议 1024×1024）或 /ai/icons/<slug>.png（第三方工具，256×256） */
  src: z.string().regex(/^\/(apps|ai)\/icons\/[a-z0-9-]+\.(svg|png|webp)$/),
  /** true = 临时占位图标，等待开发者提供真实图标 */
  placeholder: z.boolean().default(false),
  /**
   * true = 同目录下有 <slug>-{64,128,256}.{avif,webp}（自研应用另有 512），页面用 <picture> 按尺寸选图；
   * 由 scripts/icons/render.mjs 生成
   */
  variants: z.boolean().default(false),
});

const screenshots = z
  .array(
    z.object({
      src: z.string().regex(/^\/apps\/screens\/[a-z0-9-]+\/[a-z0-9-]+\.(svg|png|webp|jpg)$/),
      alt: z.string(),
      device: z.enum(['desktop', 'tablet', 'phone']),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** true = 概念图（生成的界面示意，不是真实截图），页面会明确标注「概念图」 */
      illustrative: z.boolean().default(false),
    }),
  )
  .default([]);

const price = z
  .object({
    model: z.enum(PRICE_MODELS),
    /** 付费时的价格文字，如「¥18」 */
    amount: z.string().optional(),
    /** 补充说明（第三方工具的计费方式，如「需要订阅或 API 按量计费」） */
    note: z.string().optional(),
  })
  .default({ model: 'tbd' });

const privacy = z
  .object({
    /** 收集的数据；空数组 = 不收集任何数据 */
    collects: z.array(z.string()).default([]),
    note: z.string().optional(),
    policyUrl: localOrHttps.optional(),
  })
  .optional();

const changelog = z
  .array(z.object({ version: z.string(), date, notes: z.array(z.string()).min(1) }))
  .default([]);
const faq = z.array(z.object({ q: z.string(), a: z.string() })).default([]);
const uniquePlatforms = (a: { platforms: { os: string }[] }) =>
  new Set(a.platforms.map((p) => p.os)).size === a.platforms.length;

const apps = defineCollection({
  // AZ_E2E_FIXTURES=1 时额外加载 _e2e/ 里的测试夹具应用（只给 CI / 本地 E2E 构建用，生产构建不设这个变量）
  loader: glob({
    pattern: process.env.AZ_E2E_FIXTURES ? ['*.md', '_e2e/*.md'] : '*.md',
    base: './src/content/apps',
    generateId: ({ entry }) => entry.replace(/^.*\//, '').replace(/\.md$/, ''),
  }),
  schema: z
    .object({
      /** 名称（卡片 1 行，≤ 14） */
      title: zh(14),
      /** 详情页副标题（一句话，≤ 30 字） */
      subtitle: z.string().max(30),
      /** 卡片专用一句话（6–16，1 行不截断） */
      tagline: zh(16, 6),
      /** 精选卡 / 列表简介与 SEO 描述（32–56，卡片 2 行） */
      summary: zh(56, 32),
      icon,
      hue,
      developer: z.object({
        name: z.string(),
        /** 卡片上显示的短名（≤ 12）；全称超过 12 时必填 */
        short: zh(12).optional(),
        url: localOrHttps.optional(),
        /** self = 本站作者开发；third-party = 第三方（只链官方地址，不托管安装包） */
        type: z.enum(['self', 'third-party']),
      }),
      category: z.enum(CATEGORY_IDS as [Category, ...Category[]]),
      tags: z.array(slugRef).default([]),
      platforms: z.array(appPlatform).min(1),
      screenshots,
      price,
      license: z.string(),
      openSource: z.boolean().default(false),
      website: localOrHttps.optional(),
      sourceRepo: httpsUrl.optional(),
      privacy,
      /** 按版本的更新日志，新的在前 */
      changelog,
      faq,
      featured: z.boolean().default(false),
      releaseDate: date.optional(),
      /** 最近一次更新（目录「最新」排序用）；没有任何更新记录时不写 */
      updated: date.optional(),
      /** 安装包 / 下载大小（P10 T10.2，如「18.4 MB」）；不写 = 取平台里写了的 size，都没有就不显示 */
      size: z.string().optional(),
      version: z.string(),
      status: z.string(),
      statusClass,
      order: z.number().int(),
      pinyin: z.string().default(''),
      art: z.string().nullable().default(null),
      lastChecked: date.optional(),
      relatedArticles: z.array(slugRef).default([]),
      verification: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })).default([]),
      issues: z.string().optional(),
      /** true = 档案不完整，等待作者补充（页面显示提示） */
      ownerReview: z.boolean().default(false),
      /** 站长待办：缺少的素材 / 信息（只在文档与后台显示，不对访客展示） */
      ownerTodo: z.array(z.string()).default([]),
      en: enText.optional(),
    })
    .refine(uniquePlatforms, { message: '同一平台只能出现一次' }),
});

/**
 * AI 工具（/ai/，第三方）：只链官方渠道（官网 / 应用商店 / GitHub Release / 在线使用），不托管安装包、没有直链。
 * 评分与下载计数沿用应用商店的数据表（slug 与应用不能重名，tests/unit/content.test.ts 检查）。
 */
const tools = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/tools' }),
  schema: z
    .object({
      title: zh(14),
      subtitle: z.string().max(30),
      /** 卡片专用一句话（6–16，1 行不截断） */
      tagline: zh(16, 6),
      /** 一句话简介（40–64，AI 工具卡 2 行；原创），用在卡片、搜索与 meta description */
      summary: zh(64, 40),
      icon,
      /** 卡片 / 横幅色相；不写 = 跟随主分类（AI_CATEGORY_HUE） */
      hue: hue.optional(),
      developer: z
        .object({
          name: z.string(),
          /** 卡片上显示的短名（≤ 12）；全称超过 12 时必填 */
          short: zh(12).optional(),
          /** 英文页显示的名称（全称含中文时必填，/en/ 不显示未翻译中文） */
          en: z.string().optional(),
          url: httpsUrl,
          type: z.literal('third-party'),
        })
        .refine((d) => zhLength(d.name) <= 12 || !!d.short, { message: '开发者全称超过 12 字时要写 short' })
        .refine((d) => !/[\u4e00-\u9fff]/.test(d.name) || !!d.en, {
          message: '开发者全称含中文时要写 en（英文页用）',
        }),
      /** 第一个是主分类 */
      categories: z.array(z.enum(AI_CATEGORY_IDS as [AiCategory, ...AiCategory[]])).min(1),
      tags: z.array(slugRef).default([]),
      platforms: z
        .array(appPlatform)
        .min(1)
        .refine((ps) => ps.every((p) => !!p.url && p.linkType !== 'direct'), {
          message: '第三方工具的每个平台都要有官方地址，且不能是直链',
        }),
      screenshots,
      price,
      license: z.string(),
      openSource: z.boolean(),
      website: httpsUrl,
      sourceRepo: httpsUrl.optional(),
      privacy,
      changelog,
      faq,
      featured: z.boolean().default(false),
      /** 当前版本（跟随官方更新时不写，页面显示「随官方更新」） */
      version: z.string().optional(),
      updated: date.optional(),
      /** 下载大小（P10 T10.2）；官方没有给出就不写，页面整项不显示 */
      size: z.string().optional(),
      /** 本站最后一次核对官网信息的日期（必填：第三方信息会过期） */
      lastChecked: date,
      order: z.number().int(),
      pinyin: z.string().default(''),
      en: enText.optional(),
    })
    .refine(uniquePlatforms, { message: '同一平台只能出现一次' }),
});

/**
 * 视频（/videos/）：第三方视频只做「点击才加载」的嵌入，不下载、不转载；本站存的是缩略图与原创导读。
 * 标题、频道、缩略图逐个用 oEmbed 核对；时长与发布时间只写从平台页面 / 频道 RSS 核实过的值，查不到就不写。
 * 页面上不显示、也不保存播放量。
 */
const clock = z.string().refine((s) => parseClock(s) !== null, '时长格式应为 M:SS 或 H:MM:SS');
const videos = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/videos' }),
  schema: z
    .object({
      /** 本站的中文标题（原创，不是翻译腔的直译） */
      title: zh(34, 4),
      /** 平台上的原标题（与 oEmbed 返回的 title 完全一致） */
      originalTitle: z.string(),
      /** 一段话导读（80–150 字，原创），用在卡片、搜索与 meta description */
      summary: z.string().min(80).max(150),
      provider: z.enum(VIDEO_PROVIDERS).default('youtube'),
      videoId: z.string(),
      channel: z.object({ name: z.string(), url: httpsUrl }),
      /** 第一个是主分类 */
      categories: z.array(z.enum(VIDEO_CATEGORY_IDS as [VideoCategory, ...VideoCategory[]])).min(1),
      tags: z.array(slugRef).default([]),
      /** 已核实的时长（来自平台频道 / 播放列表页），查不到就不写 */
      duration: clock.optional(),
      /** 已核实的发布时间（ISO 8601，来自频道 RSS），查不到就不写 */
      published: z.string().datetime({ offset: true }).optional(),
      /** 视频语言（BCP 47） */
      lang: z.string().default('en'),
      /** 章节：只收录作者在视频简介里给出的时间点（标题为本站翻译） */
      chapters: z.array(z.object({ t: clock, label: z.string() })).default([]),
      /** 相关的 AI 工具（/ai/<slug>/）与本站应用（/apps/<slug>/） */
      relatedTools: z.array(slugRef).default([]),
      relatedApps: z.array(slugRef).default([]),
      /** true = 站长本人的视频（「我的视频」区） */
      owner: z.boolean().default(false),
      featured: z.boolean().default(false),
      /** 本站最后一次核对（oEmbed 可嵌入、标题、频道）的日期 */
      lastChecked: date,
      /** 核对来源说明 */
      verifiedBy: z.string().default('YouTube oEmbed + 频道 RSS'),
      order: z.number().int(),
      pinyin: z.string().default(''),
      /** 英文版简介（英文标题用 originalTitle） */
      en: enText.omit({ title: true, subtitle: true }).optional(),
    })
    .refine((v) => VIDEO_ID_RE[v.provider].test(v.videoId), { message: '视频 ID 与平台格式不符' }),
});

const games = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/games' }),
  schema: z.object({
    title: z.string(),
    kind: z.string(),
    art: z.string(),
    hue,
    version: z.string(),
    status: z.string(),
    date,
    order: z.number().int(),
    pinyin: z.string().default(''),
    genre: z.string(),
    /** 运行平台（P10 T10.2）：只写有依据的（如浏览器游戏写 web）；不写 = 页面不显示平台 */
    platforms: z.array(PLATFORM_OS).optional(),
    /** 下载大小 / 许可（P10 T10.2，可选，没有就不显示） */
    size: z.string().optional(),
    license: z.string().optional(),
    facts: z.array(fact),
    log: z.array(z.object({ version: z.string(), date, note: z.string() })),
    issues: z.string(),
    /** 试玩地址（站内路径或 https 外链）；有值时详情页首屏主按钮是「试玩」（T9.12） */
    playUrl: z
      .string()
      .regex(/^(\/|https:\/\/)/)
      .optional(),
    /** 演示视频：本站 videos 集合的 slug；没有试玩时主按钮是「观看演示」 */
    demoVideo: z.string().optional(),
    en: enText
      .omit({ subtitle: true })
      .extend({ kind: z.string(), status: z.string(), genre: z.string() })
      .optional(),
  }),
});

const articles = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/articles' }),
  schema: z.object({
    /** 标题（媒体卡 2 行，≤ 36） */
    title: zh(36),
    category: z.string(),
    badge: z.string(),
    author: z.string(),
    date,
    lastChecked: date,
    readingMinutes: z.number().int().positive(),
    toc: z.array(z.string()),
    tags: z.array(slugRef),
    forumThread: z.string().nullable(),
    ogImage: z.string().startsWith('/'),
    art: z.string().nullable(),
    pinyin: z.string().default(''),
    order: z.number().int(),
    /** 一句话摘要（列表、搜索结果与 meta description）；不写 = 取正文前 120 字 */
    description: zh(110, 60).optional(),
    /**
     * 联盟 / 赞助披露（P8 T8.7）：affiliate = 文中有联盟链接；sponsored = 整篇是赞助内容（写明 sponsor）。
     * 正文含 rel="sponsored" 链接而没写这个字段时，文章页按 affiliate 显示披露标识。
     */
    disclosure: z
      .object({
        type: z.enum(['affiliate', 'sponsored']),
        sponsor: z.string().optional(),
        note: z.string().optional(),
      })
      .optional(),
    /** 联盟 / 赞助链接地址：正文里指向这些地址的 <a> 会自动加 rel="sponsored nofollow noopener" */
    sponsoredLinks: z.array(httpsUrl).default([]),
  }),
});

const works = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/works' }),
  schema: z.object({
    title: z.string(),
    kind: z.string(),
    art: z.string(),
    hue,
    date,
    status: z.string(),
    order: z.number().int(),
    pinyin: z.string().default(''),
    facts: z.array(fact),
    related: z.array(z.object({ type: z.enum(['app', 'game', 'article', 'work']), slug: slugRef })),
  }),
});

export const collections = { apps, tools, videos, games, articles, works };
