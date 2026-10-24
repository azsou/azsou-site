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

const hue = z.enum(['accent', 'green', 'teal', 'blue', 'orange']);
const date = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, '日期格式应为 YYYY-MM 或 YYYY-MM-DD');
const fact = z.object({ label: z.string(), value: z.string() });
const slugRef = z.string().regex(/^[a-z0-9-]+$/);

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
      title: z.string(),
      /** App Store 式副标题（一句话，≤ 30 字） */
      subtitle: z.string().max(30),
      /** 列表与 SEO 描述（一两句） */
      summary: z.string(),
      icon,
      hue,
      developer: z.object({
        name: z.string(),
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
      title: z.string(),
      subtitle: z.string().max(30),
      /** 一句话简介（60–120 字，原创），用在卡片、搜索与 meta description */
      summary: z.string().min(40).max(140),
      icon,
      developer: z.object({
        name: z.string(),
        url: httpsUrl,
        type: z.literal('third-party'),
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
      /** 本站最后一次核对官网信息的日期（必填：第三方信息会过期） */
      lastChecked: date,
      order: z.number().int(),
      pinyin: z.string().default(''),
    })
    .refine(uniquePlatforms, { message: '同一平台只能出现一次' }),
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
    facts: z.array(fact),
    log: z.array(z.object({ version: z.string(), date, note: z.string() })),
    issues: z.string(),
  }),
});

const articles = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
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

export const collections = { apps, tools, games, articles, works };
