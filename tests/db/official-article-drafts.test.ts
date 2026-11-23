import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { U } from './fixtures';
import { ADMIN_URL, ROOT, run, type Outcome, type Who } from './helpers';
import { freshDb } from './setup';

const admin: Who = { role: 'authenticated', uid: U.ada };
const pilot = join(ROOT, 'db/pilots/article-drafts.sql');
let db: Awaited<ReturnType<typeof freshDb>>;

beforeAll(async () => {
  const host = new URL(ADMIN_URL).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('Local CI PostgreSQL only');
  db = await freshDb('cmsarticle');
  if (!/^azsou_test_cmsarticle_[0-9]+$/.test(db.name)) throw new Error('Unexpected pilot database');
  // Test-first: on the baseline run all assertions against the unchanged database, with NO fallback or mock.
  // Once the candidate exists, apply its exact SQL only to this test file's disposable database.
  if (existsSync(pilot)) await db.pool.query(readFileSync(pilot, 'utf8'));
});

afterAll(async () => {
  if (db) await db.close();
});

function ok(o: Outcome) {
  if (!o.ok) throw new Error(`Unexpected database error ${o.code}: ${o.message}`);
  return o.rows;
}

function fields(title: string) {
  return { title, toc: ['Test section'], extra: { synthetic: true } };
}

function save(slug: string, base: number, title: string, body: string, who: Who = admin) {
  const sql = 'select * from public.az_cms_save_article_draft($1, $2, $3::jsonb, $4)';
  return run(db.pool, who, sql, [slug, base, JSON.stringify(fields(title)), body], { commit: true });
}

function read(slug: string, who: Who = admin) {
  return run(db.pool, who, 'select * from public.az_cms_read_article_draft($1)', [slug]);
}

describe('official article draft storage in a disposable database', () => {
  it('persists a private first revision and its metadata across transactions', async () => {
    const slug = 'ci-draft-roundtrip';
    const created = ok(await save(slug, 0, 'Sample one', 'Test body'));
    expect(created).toEqual([{ item_id: expect.any(String), revision: 1 }]);
    const expected = { ...created[0], fields: fields('Sample one'), body_source: 'Test body' };
    expect(ok(await read(slug))).toEqual([expected]);
    const receipt = await db.pool.query(
      `select a.published_revision, r.saved_by from private.cms_article_items a
       join private.cms_article_revisions r on r.item_id = a.id and r.revision = a.draft_revision
       where a.slug = $1`,
      [slug],
    );
    expect(receipt.rows).toEqual([{ published_revision: null, saved_by: U.ada }]);
  });

  it('editing a published item leaves its published pointer and old bytes unchanged', async () => {
    const slug = 'ci-draft-live-pointer';
    const [first] = ok(await save(slug, 0, 'Old title', 'Old body'));
    // Seed an already-published revision in the test fixture. This is NOT an application publish API.
    const seedPointer = 'update private.cms_article_items set published_revision = 1 where id = $1';
    await db.pool.query(seedPointer, [first.item_id]);
    const [next] = ok(await save(slug, 1, 'New title', 'Private body'));
    expect(next).toEqual({ item_id: first.item_id, revision: 2 });
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 2, body_source: 'Private body' });
    const live = await db.pool.query(
      `select a.published_revision as revision, r.fields, r.body_source from private.cms_article_items a
       join private.cms_article_revisions r on r.item_id = a.id and r.revision = a.published_revision
       where a.slug = $1`,
      [slug],
    );
    expect(live.rows).toEqual([{ revision: 1, fields: fields('Old title'), body_source: 'Old body' }]);
  });

  it('allows only one of two saves based on the same revision', async () => {
    const slug = 'ci-draft-conflict';
    const [first] = ok(await save(slug, 0, 'Base', 'base'));
    const left = save(slug, 1, 'Left', 'left');
    const right = save(slug, 1, 'Right', 'right');
    const results = await Promise.all([left, right]);
    expect(results.filter((o) => o.ok)).toHaveLength(1);
    expect(results.filter((o) => !o.ok)).toMatchObject([{ code: 'PT409' }]);
    const winningBody = results[0].ok ? 'left' : 'right';
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 2, body_source: winningBody });
    const history = await db.pool.query(
      'select revision from private.cms_article_revisions where item_id = $1 order by revision',
      [first.item_id],
    );
    expect(history.rows).toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it('restricts draft reads and writes to the station administrator', async () => {
    const slug = 'ci-draft-private';
    ok(await save(slug, 0, 'Private', 'private'));
    const others: Who[] = [
      { role: 'anon' },
      { role: 'authenticated', uid: U.alice },
      { role: 'authenticated', uid: U.mia },
      { role: 'authenticated', uid: U.carol },
    ];
    for (const who of others) {
      expect(await read(slug, who)).toMatchObject({ ok: false, code: '42501' });
      expect(await save(slug, 1, 'Changed', 'changed', who)).toMatchObject({ ok: false, code: '42501' });
    }
    expect(ok(await read(slug))[0]).toMatchObject({ revision: 1, body_source: 'private' });
    const grants = await db.pool.query(
      `select has_table_privilege('anon', 'private.cms_article_revisions', 'select') as anon_read,
              has_table_privilege('authenticated', 'private.cms_article_items', 'update') as raw_edit`,
    );
    expect(grants.rows).toEqual([{ anon_read: false, raw_edit: false }]);
  });

  it('rejects an empty title and a nonzero first base without leaving a phantom item', async () => {
    const slug = 'ci-draft-validation';
    expect(await save(slug, 0, ' ', 'body')).toMatchObject({ ok: false, code: '22023' });
    expect(await save(slug, 3, 'Missing base', 'body')).toMatchObject({ ok: false, code: 'PT409' });
    expect(ok(await read(slug))).toEqual([]);
    const items = await db.pool.query('select id from private.cms_article_items where slug = $1', [slug]);
    expect(items.rows).toEqual([]);
  });
});
