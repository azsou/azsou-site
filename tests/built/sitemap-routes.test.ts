import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = 'dist/client';
const site = 'https://azsou.com';

// The generated sitemap puts the primary <loc> first in each entry. Ignore alternate-language links.
function locations(xml: string, tag: 'sitemap' | 'url'): URL[] {
  const entries = new RegExp(`<${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return Array.from(xml.matchAll(entries), ([, entry]) => {
    const text = /^\s*<loc>([^<]+)<\/loc>/.exec(entry ?? '')?.[1]?.trim();
    if (!text) throw new Error(`Missing primary loc in sitemap ${tag} entry`);
    return new URL(text.replace(/&amp;/g, '&'));
  });
}

it('keeps the canonical article index but excludes live pilot routes from the built sitemap', () => {
  const index = fs.readFileSync(path.join(root, 'sitemap-index.xml'), 'utf8');
  const children = locations(index, 'sitemap');
  expect(children.length).toBeGreaterThan(0);
  const urls = children.flatMap((child) => {
    if (child.origin !== site || child.search || child.hash || !/^\/sitemap-\d+\.xml$/.test(child.pathname)) {
      throw new Error('Unexpected sitemap index entry, not a local generated sitemap');
    }
    const file = path.join(root, child.pathname.slice(1));
    return locations(fs.readFileSync(file, 'utf8'), 'url');
  });
  const routes = urls.filter((url) => url.origin === site).map((url) => url.pathname);
  expect(routes).toContain('/articles/');
  expect(routes.filter((p) => p === '/articles/live' || p.startsWith('/articles/live/'))).toEqual([]);
});
