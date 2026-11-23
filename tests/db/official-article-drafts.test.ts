import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApiFor } from '@/lib/data/admin-repo';
import { memoryStore } from '@/lib/data/session';
import { createSupabaseRepository } from '@/lib/data/supabase';
import { ForbiddenError, NotSignedInError } from '@/lib/data/types';
import { U } from './fixtures';
import { ADMIN_URL, ROOT, run, type Outcome, type Who } from './helpers';
import { ANON, BIN, freePort, startPostgrest, tok } from './postgrest';
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

// SB04: use the same file's guarded disposable database and its installed pilot SQL.
// Session identities are generated by the existing local test fixture, not by hosted Auth.
type HttpFields = Record<string, unknown> & { title: string };
type HttpInput = { slug: string; expectedRevision: number; fields: HttpFields; bodySource: string };
type HttpReceipt = { itemId: string; revision: number };
interface DraftPortContract {
  read(slug: string): Promise<(HttpReceipt & { fields: HttpFields; bodySource: string }) | null>;
  save(input: HttpInput): Promise<HttpReceipt>;
}

describe.skipIf(!BIN && !process.env.CI)('official article draft workbench over local PostgREST', () => {
  let server: ChildProcess | undefined;
  let origin: string;

  beforeAll(async () => {
    if (!BIN) throw new Error('SB04: CI must provide PostgREST for the article draft HTTP contract');
    const port = await freePort();
    server = await startPostgrest(db.name, port);
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.kill();
  });

  function client(uid: string | null, syntheticReply?: () => Response) {
    const trace: { path: string; status: number }[] = [];
    const store = memoryStore(
      uid
        ? {
            accessToken: tok(uid),
            refreshToken: 'local-fixture-only',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            user: { id: uid, email: null, emailConfirmed: true, provider: 'email' },
          }
        : null,
    );
    const repo = createSupabaseRepository({
      url: origin,
      key: ANON,
      store,
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== origin || !target.pathname.startsWith('/rest/v1/rpc/')) {
          throw new Error('SB04: loopback draft RPC transport only');
        }
        // The standalone test binary has no Supabase gateway prefix.
        target.pathname = target.pathname.slice('/rest/v1'.length);
        const localFetch = () => fetch(target, { ...init, redirect: 'error' });
        const response = syntheticReply ? syntheticReply() : await localFetch();
        trace.push({ path: target.pathname, status: response.status });
        return response;
      },
    });
    const workbench = adminApiFor(repo);
    if (!workbench) throw new Error('SB04: expected the existing Supabase admin workbench');
    // Test the existing entry point, not a missing import. The baseline should fail this assertion.
    expect(workbench, 'SB04: admin workbench must expose articleDrafts').toHaveProperty('articleDrafts');
    const drafts = Reflect.get(workbench, 'articleDrafts') as DraftPortContract;
    return { drafts, trace };
  }

  const draftInput = (slug: string): HttpInput => ({
    slug,
    expectedRevision: 0,
    fields: { title: 'CI article', toc: ['First'], optional: { labels: ['保留', 'test'] } },
    bodySource: '  <p>合成稿</p>\n',
  });

  it('reads a missing slug as null and round-trips the full draft through a fresh client', async () => {
    const a = client(U.ada);
    const draft = draftInput('ci-http-article-roundtrip');
    expect(await a.drafts.read(draft.slug)).toBeNull();
    const saved = await a.drafts.save(draft);
    expect(saved).toEqual({ itemId: expect.any(String), revision: 1 });
    const reopened = await client(U.ada).drafts.read(draft.slug);
    expect(reopened).toEqual({ ...saved, fields: draft.fields, bodySource: draft.bodySource });
    const paths = ['/rpc/az_cms_read_article_draft', '/rpc/az_cms_save_article_draft'];
    expect(a.trace.map((r) => r.path)).toEqual(paths);
  });

  it('rejects a stale save once with HTTP 409 and leaves the newer draft intact', async () => {
    const a = client(U.ada);
    const b = client(U.ada);
    const draft = draftInput('ci-http-article-conflict');
    const first = await a.drafts.save(draft);
    const loaded = await b.drafts.read(draft.slug);
    expect(loaded?.revision).toBe(first.revision);
    const current = { ...draft, expectedRevision: first.revision, bodySource: 'Newer body' };
    const next = await a.drafts.save(current);
    expect(next).toEqual({ itemId: first.itemId, revision: 2 });
    const from = b.trace.length;
    const stale = { ...draft, expectedRevision: first.revision, bodySource: 'Stale body' };
    await expect(b.drafts.save(stale)).rejects.toThrow(/article draft version conflict/);
    expect(b.trace.slice(from)).toEqual([{ path: '/rpc/az_cms_save_article_draft', status: 409 }]);
    const winner = { ...next, fields: draft.fields, bodySource: 'Newer body' };
    expect(await b.drafts.read(draft.slug)).toEqual(winner);
  });

  it('requires a session and lets the database reject ordinary users and moderators', async () => {
    const draft = draftInput('ci-http-article-private');
    const station = client(U.ada);
    const saved = await station.drafts.save(draft);
    const change = { ...draft, expectedRevision: saved.revision, bodySource: 'Unaccepted edit' };
    const guest = client(null);
    await expect(guest.drafts.read(draft.slug)).rejects.toBeInstanceOf(NotSignedInError);
    await expect(guest.drafts.save(change)).rejects.toBeInstanceOf(NotSignedInError);
    expect(guest.trace).toEqual([]);
    for (const uid of [U.alice, U.mia]) {
      const other = client(uid);
      await expect(other.drafts.read(draft.slug)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(other.drafts.save(change)).rejects.toBeInstanceOf(ForbiddenError);
      expect(other.trace.map((r) => r.status)).toEqual([403, 403]);
    }
    const original = { ...saved, fields: draft.fields, bodySource: draft.bodySource };
    expect(await station.drafts.read(draft.slug)).toEqual(original);
  });

  it('does not treat a missing endpoint as a missing draft or try a fallback write', async () => {
    const missing = () => Response.json({ code: 'PGRST202', message: 'Test RPC missing' }, { status: 404 });
    const a = client(U.ada, missing);
    const draft = draftInput('ci-http-article-schema');
    const schema = { name: 'SchemaMissingError', kind: 'schema' };
    const readError = { ...schema, object: 'az_cms_read_article_draft' };
    const saveError = { ...schema, object: 'az_cms_save_article_draft' };
    await expect(a.drafts.read(draft.slug)).rejects.toMatchObject(readError);
    await expect(a.drafts.save(draft)).rejects.toMatchObject(saveError);
    expect(a.trace.map((r) => r.status)).toEqual([404, 404]);
  });

  it('rejects malformed success replies instead of returning an empty draft or a fake receipt', async () => {
    const draft = draftInput('ci-http-article-response');
    const row = { item_id: U.ada, revision: 1, fields: draft.fields, body_source: draft.bodySource };
    for (const reply of [null, [row, row], [{ ...row, body_source: 3 }]]) {
      const a = client(U.ada, () => Response.json(reply));
      await expect(a.drafts.read(draft.slug)).rejects.toMatchObject({ kind: 'bad-response' });
      expect(a.trace).toHaveLength(1);
    }
    for (const reply of [[], [{ ...row, item_id: '' }], [{ ...row, revision: 3 }]]) {
      const a = client(U.ada, () => Response.json(reply));
      await expect(a.drafts.save(draft)).rejects.toMatchObject({ kind: 'bad-response' });
      expect(a.trace).toHaveLength(1);
    }
  });
});
