import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const hue = z.enum(['accent', 'green', 'teal', 'blue', 'orange']);
const date = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, '日期格式应为 YYYY-MM 或 YYYY-MM-DD');
const fact = z.object({ label: z.string(), value: z.string() });
const slugRef = z.string().regex(/^[a-z0-9-]+$/);

export const statusClass = z.enum(['active', 'review', 'stable', 'experiment']);

/* 正文均为迁移来的 HTML，页面用 set:html 原样输出（不经 Markdown 二次处理） */

const apps = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/apps' }),
  schema: z.object({
    title: z.string(),
    kind: z.string(),
    icon: z.string().max(4),
    hue,
    summary: z.string(),
    version: z.string(),
    status: z.string(),
    statusClass,
    order: z.number().int(),
    pinyin: z.string().default(''),
    art: z.string().nullable().default(null),
    lastChecked: date.optional(),
    platform: z.string().optional(),
    testEnv: z.string().optional(),
    relatedArticles: z.array(slugRef).default([]),
    updates: z.array(z.object({ change: z.string(), kind: z.string(), note: z.string(), date })).default([]),
    history: z.array(z.object({ date, version: z.string(), note: z.string() })).default([]),
    verification: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })).default([]),
    issues: z.string().optional(),
    /** true = v2 迁移时补建的最小档案，等待作者补充 */
    ownerReview: z.boolean().default(false),
  }),
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

export const collections = { apps, games, articles, works };
